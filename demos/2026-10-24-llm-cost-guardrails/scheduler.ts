// 第 3 层的"速率类"限制：并发上限 + 有界公平队列 + 背压。
// 速率类限制过一会儿就恢复，所以可以排队；但队列必须有界，满了就快速拒绝（429 + Retry-After）。

import { RateLimitedError } from "./errors.js";
import type { Clock } from "./store.js";

interface Job {
  userId: string;
  task: () => Promise<unknown>;
  resolve: (v: any) => void;
  reject: (e: unknown) => void;
  enqueuedAt: number;
}

export interface SchedulerOpts {
  maxConcurrent: number; // 全局并发
  maxPerUser: number; // 每用户并发
  maxQueued: number; // 全局队列长度上限
  maxQueuedPerUser: number; // 每用户队列长度上限：热用户只能占满自己的份额
  maxWaitMs: number; // 排队等待时间上限
  avgTaskMs: number; // 用来估算 Retry-After（生产里用滑动平均）
}

export class FairScheduler {
  private active = new Map<string, number>();
  private activeTotal = 0;
  private queues = new Map<string, Job[]>();

  constructor(private o: SchedulerOpts, private clock: Clock) {}

  get queued() {
    let n = 0;
    for (const q of this.queues.values()) n += q.length;
    return n;
  }
  private userActive(u: string) {
    return this.active.get(u) ?? 0;
  }
  private userQueued(u: string) {
    return this.queues.get(u)?.length ?? 0;
  }
  private retryAfter() {
    // 粗估：排在我前面的活 ÷ 并发 × 单个平均耗时，至少 1 秒
    return Math.max(1, Math.ceil(((this.queued + 1) / this.o.maxConcurrent) * (this.o.avgTaskMs / 1000)));
  }

  submit<T>(userId: string, task: () => Promise<T>): Promise<T> {
    this.expire();
    // 有空位且该用户没到并发上限 → 马上能跑，不占队列名额
    const canRunNow = this.activeTotal < this.o.maxConcurrent && this.userActive(userId) < this.o.maxPerUser;
    if (!canRunNow) {
      if (this.userQueued(userId) >= this.o.maxQueuedPerUser)
        return Promise.reject(new RateLimitedError("user_queue_full", this.retryAfter()));
      if (this.queued >= this.o.maxQueued) return Promise.reject(new RateLimitedError("queue_full", this.retryAfter()));
    }
    return new Promise<T>((resolve, reject) => {
      const job: Job = { userId, task, resolve, reject, enqueuedAt: this.clock.now() };
      if (!this.queues.has(userId)) this.queues.set(userId, []);
      this.queues.get(userId)!.push(job);
      this.pump();
    });
  }

  /** 等太久的任务直接拒绝，别让调用方无限等。（demo 在 submit/pump 时顺带清理；生产里用定时器。） */
  private expire() {
    const now = this.clock.now();
    for (const [u, q] of this.queues) {
      while (q.length && now - q[0].enqueuedAt > this.o.maxWaitMs) {
        q.shift()!.reject(new RateLimitedError("queue_wait_exceeded", this.retryAfter()));
      }
      if (!q.length) this.queues.delete(u);
    }
  }

  private pump() {
    this.expire();
    while (this.activeTotal < this.o.maxConcurrent) {
      // 公平：在"还有名额"的用户里，优先选【正在跑的最少】的；并列则选队头等得最久的
      let best: { u: string; q: Job[] } | undefined;
      for (const [u, q] of this.queues) {
        if (!q.length || this.userActive(u) >= this.o.maxPerUser) continue;
        if (
          !best ||
          this.userActive(u) < this.userActive(best.u) ||
          (this.userActive(u) === this.userActive(best.u) && q[0].enqueuedAt < best.q[0].enqueuedAt)
        )
          best = { u, q };
      }
      if (!best) return;
      const job = best.q.shift()!;
      if (!best.q.length) this.queues.delete(best.u);
      this.start(job);
    }
  }

  private start(job: Job) {
    this.activeTotal++;
    this.active.set(job.userId, this.userActive(job.userId) + 1);
    job
      .task()
      .then(job.resolve, job.reject)
      .finally(() => {
        this.activeTotal--;
        this.active.set(job.userId, this.userActive(job.userId) - 1);
        this.pump();
      });
  }
}
