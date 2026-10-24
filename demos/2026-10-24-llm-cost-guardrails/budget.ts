// 用户/全局日预算：预占（reserve）+ 结算（settle）。
// 和 10-16 的 max_tokens 预留是同一个思路：调用前按"最坏情况"占额度，调用后按实际用量退差额。
// 金额单位：微美元（µ$，整数，避免浮点误差）。

import { QuotaExceededError } from "./errors.js";
import type { Clock, StateStore } from "./store.js";

export const PRICE = { inputPerToken: 3, outputPerToken: 15 }; // µ$：$3 / $15 每百万 token

export const costOf = (inputTokens: number, outputTokens: number) =>
  inputTokens * PRICE.inputPerToken + outputTokens * PRICE.outputPerToken;

/** 最坏情况：输入已知，输出按 max_tokens（它是硬上限）。 */
export const worstCase = (inputTokens: number, maxTokens: number) => costOf(inputTokens, maxTokens);

export interface Reservation {
  scopes: { key: string; scope: "user_daily" | "global_daily"; resetAt: number }[];
  amount: number;
}

const DAY = 24 * 3600 * 1000;

export class BudgetManager {
  constructor(
    private store: StateStore,
    private clock: Clock,
    private limits: { userDaily: number; globalDaily: number },
  ) {}

  private keys(userId: string) {
    const day = Math.floor(this.clock.now() / DAY);
    const resetAt = (day + 1) * DAY;
    return [
      { key: `budget:user:${userId}:${day}`, scope: "user_daily" as const, limit: this.limits.userDaily, resetAt },
      { key: `budget:global:${day}`, scope: "global_daily" as const, limit: this.limits.globalDaily, resetAt },
    ];
  }

  /** 先用户级、后全局；任一层超额就回滚已占的、抛 402。 */
  async reserve(userId: string, amount: number): Promise<Reservation> {
    const taken: ReturnType<BudgetManager["keys"]> = [];
    for (const k of this.keys(userId)) {
      const r = await this.store.incrIfBelow(k.key, amount, k.limit);
      if (!r.ok) {
        for (const t of taken) await this.store.incr(t.key, -amount); // 回滚
        throw new QuotaExceededError(k.scope, k.resetAt);
      }
      taken.push(k);
    }
    return { scopes: taken.map(({ key, scope, resetAt }) => ({ key, scope, resetAt })), amount };
  }

  /** 结算：把预占换成实际花费，差额退回（actual 通常小于预占）。 */
  async settle(r: Reservation, actual: number) {
    const diff = actual - r.amount; // 负数 = 退回
    if (diff !== 0) for (const s of r.scopes) await this.store.incr(s.key, diff);
  }

  async used(userId: string) {
    const [u, g] = this.keys(userId);
    return {
      user: Number((await this.store.get(u.key)) ?? 0),
      global: Number((await this.store.get(g.key)) ?? 0),
    };
  }
}
