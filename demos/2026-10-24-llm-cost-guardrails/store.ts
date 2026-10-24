// 状态存取抽象：护栏的"记忆"全部走这个接口。
// 这里用内存 Map 实现，只为了让 demo 能离线跑；
// ⚠️ 生产环境：权威状态放数据库，热路径用 Redis，进程内存只能当几秒的兜底缓存。
//
//   incr          → Postgres: UPDATE t SET n = n + $1 WHERE id = $2 RETURNING n      | Redis: INCRBY
//   incrIfBelow   → Postgres: UPDATE t SET used = used + $1 WHERE id = $2 AND used + $1 <= $3 RETURNING used
//                   （0 行返回 = 超额）                                              | Redis: Lua 脚本
//   setIfAbsent   → Postgres: INSERT ... ON CONFLICT DO NOTHING                      | Redis: SET key v NX PX ttl
//
// 关键：检查和写入必须是【一条】原子操作。先 get 再 set，并发时会少算（见 demo.ts 第 5 节）。

export type Value = number | string;

export interface Clock {
  now(): number;
}

export class SystemClock implements Clock {
  now() {
    return Date.now();
  }
}

/** 可手动拨动的时钟，让测试不用真的 sleep。 */
export class FakeClock implements Clock {
  constructor(public t = 0) {}
  now() {
    return this.t;
  }
  advance(ms: number) {
    this.t += ms;
  }
}

export interface StateStore {
  get(key: string): Promise<Value | undefined>;
  set(key: string, value: Value, ttlMs?: number): Promise<void>;
  del(key: string): Promise<void>;
  /** 原子自增，返回自增后的值。 */
  incr(key: string, by?: number): Promise<number>;
  /** 原子的"没超额才加"。预占额度就靠它。 */
  incrIfBelow(key: string, by: number, limit: number): Promise<{ ok: boolean; value: number }>;
  /** 原子的"不存在才写"（SET NX）。半开状态下抢探测名额就靠它。 */
  setIfAbsent(key: string, value: Value, ttlMs: number): Promise<boolean>;
}

export class MemoryStore implements StateStore {
  private m = new Map<string, { v: Value; exp?: number }>();
  constructor(private clock: Clock) {}

  private live(key: string) {
    const e = this.m.get(key);
    if (!e) return undefined;
    if (e.exp !== undefined && e.exp <= this.clock.now()) {
      this.m.delete(key);
      return undefined;
    }
    return e;
  }
  // 下面每个方法体里没有 await：在单线程 JS 里等于原子。真实后端靠数据库/Redis 保证原子。
  async get(key: string) {
    return this.live(key)?.v;
  }
  async set(key: string, value: Value, ttlMs?: number) {
    this.m.set(key, { v: value, exp: ttlMs ? this.clock.now() + ttlMs : undefined });
  }
  async del(key: string) {
    this.m.delete(key);
  }
  async incr(key: string, by = 1) {
    const cur = Number(this.live(key)?.v ?? 0) + by;
    const old = this.m.get(key);
    this.m.set(key, { v: cur, exp: old?.exp });
    return cur;
  }
  async incrIfBelow(key: string, by: number, limit: number) {
    const cur = Number(this.live(key)?.v ?? 0);
    if (cur + by > limit) return { ok: false, value: cur };
    const old = this.m.get(key);
    this.m.set(key, { v: cur + by, exp: old?.exp });
    return { ok: true, value: cur + by };
  }
  async setIfAbsent(key: string, value: Value, ttlMs: number) {
    if (this.live(key)) return false;
    this.m.set(key, { v: value, exp: this.clock.now() + ttlMs });
    return true;
  }
}
