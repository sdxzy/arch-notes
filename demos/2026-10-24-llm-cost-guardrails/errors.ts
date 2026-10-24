// 护栏拒绝时的错误语义：不同原因要给调用方不同的"下一步该怎么办"。

export class GuardError extends Error {
  constructor(
    public code: string,
    message: string,
    public http: number,
    public headers: Record<string, string> = {},
    public body: Record<string, unknown> = {},
  ) {
    super(message);
  }
  toHttp() {
    return {
      status: this.http,
      headers: this.headers,
      body: { error: { code: this.code, message: this.message, ...this.body } },
    };
  }
}

/** 速率类：过一会儿会恢复 → 429 + Retry-After，调用方可以自动重试。 */
export class RateLimitedError extends GuardError {
  constructor(public reason: "queue_full" | "user_queue_full" | "queue_wait_exceeded", public retryAfterSec: number) {
    super("rate_limited", `系统繁忙（${reason}），请 ${retryAfterSec}s 后重试`, 429, { "Retry-After": String(retryAfterSec) }, {
      reason,
      retry_after: retryAfterSec,
    });
  }
}

/** 额度类：累计、到重置时间才恢复 → 不要 Retry-After，用 402 + 明确错误码，
 *  避免客户端把它当"瞬时 429"自动重试而形成重试风暴。 */
export class QuotaExceededError extends GuardError {
  constructor(public scope: "user_daily" | "global_daily", public resetAt: number) {
    super("quota_exceeded", `额度已用完（${scope}），将于 ${new Date(resetAt).toISOString()} 重置`, 402, {}, {
      scope,
      reset_at: new Date(resetAt).toISOString(),
    });
  }
}

/** 断路器打开：这个调度被暂停，等人处理或冷却。 */
export class CircuitOpenError extends GuardError {
  constructor(public scheduleId: string, public resumeAt: number) {
    super("schedule_paused", `调度 ${scheduleId} 连续失败已暂停`, 409, {}, {
      schedule_id: scheduleId,
      resume_at: new Date(resumeAt).toISOString(),
    });
  }
}

/** run 内部限制：不是 HTTP 错误，是"这个任务被护栏终止"。 */
export type RunLimitReason = "max_steps" | "max_cost" | "max_tokens" | "timeout" | "repeat_action" | "max_tool_errors";
export class RunLimitError extends Error {
  constructor(public reason: RunLimitReason, public detail: string) {
    super(`run 被护栏终止：${reason}（${detail}）`);
  }
}
