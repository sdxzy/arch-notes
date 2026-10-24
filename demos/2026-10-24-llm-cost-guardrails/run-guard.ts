// 第 2 层：单个 run（一次任务）的护栏。死循环就是在这一层转起来的。
// 只数"重试次数"拦不住无报错的循环，所以这里同时看：步数、花费、token、总时长、重复动作、工具连续报错。

import { BudgetManager, costOf, worstCase } from "./budget.js";
import { RunLimitError } from "./errors.js";
import type { Clock } from "./store.js";

export interface Action {
  tool: string;
  args: unknown;
}
export interface LLM {
  chat(req: { inputTokens: number; maxTokens: number }): Promise<{ action: Action; usage: { inputTokens: number; outputTokens: number } }>;
}

export interface RunLimits {
  maxSteps: number;
  maxCostMicro: number;
  maxTokens: number;
  maxWallMs: number;
  /** 连续出现 N 次完全相同的动作（工具+参数）就判定为死循环。 */
  repeatThreshold: number;
  /** 工具连续报错 N 次。这就是 Dong 最初想到的"重试次数上限"。 */
  maxToolErrors: number;
}

export const DEFAULT_LIMITS: RunLimits = {
  maxSteps: 30,
  maxCostMicro: 300_000, // $0.30
  maxTokens: 200_000,
  maxWallMs: 120_000,
  repeatThreshold: 6,
  maxToolErrors: 5,
};

export class GuardedRun {
  steps = 0;
  costMicro = 0;
  tokens = 0;
  toolErrors = 0;
  private startedAt: number;
  private lastSig = "";
  private repeat = 0;

  constructor(
    private o: { userId: string; limits: RunLimits; llm: LLM; clock: Clock; budget?: BudgetManager },
  ) {
    this.startedAt = o.clock.now();
  }

  /** 一次 LLM 调用：先查 run 级上限 → 预占用户/全局预算 → 调用 → 结算 → 查重复动作。 */
  async step(inputTokens: number, maxTokens: number): Promise<Action> {
    const L = this.o.limits;
    if (this.steps >= L.maxSteps) throw new RunLimitError("max_steps", `已 ${this.steps} 步`);
    if (this.o.clock.now() - this.startedAt > L.maxWallMs) throw new RunLimitError("timeout", `超过 ${L.maxWallMs}ms`);
    if (this.tokens + inputTokens + maxTokens > L.maxTokens)
      throw new RunLimitError("max_tokens", `累计 ${this.tokens} + 本步最坏 ${inputTokens + maxTokens}`);
    const estimate = worstCase(inputTokens, maxTokens);
    if (this.costMicro + estimate > L.maxCostMicro)
      throw new RunLimitError("max_cost", `已花 ${this.costMicro}µ$ + 本步最坏 ${estimate}µ$ > ${L.maxCostMicro}µ$`);

    const reservation = this.o.budget ? await this.o.budget.reserve(this.o.userId, estimate) : undefined; // 超额抛 402
    let res;
    try {
      res = await this.o.llm.chat({ inputTokens, maxTokens });
    } catch (e) {
      if (reservation) await this.o.budget!.settle(reservation, 0); // 调用失败：全额退回
      throw e;
    }
    const actual = costOf(res.usage.inputTokens, res.usage.outputTokens);
    if (reservation) await this.o.budget!.settle(reservation, actual);

    this.steps++;
    this.costMicro += actual;
    this.tokens += res.usage.inputTokens + res.usage.outputTokens;

    const sig = `${res.action.tool}:${JSON.stringify(res.action.args)}`;
    this.repeat = sig === this.lastSig ? this.repeat + 1 : 1;
    this.lastSig = sig;
    if (this.repeat >= L.repeatThreshold)
      throw new RunLimitError("repeat_action", `同一动作连续 ${this.repeat} 次：${sig}`);
    return res.action;
  }

  /** agent 代码在工具报错时调用；成功时调 toolOk() 清零。 */
  toolError() {
    this.toolErrors++;
    if (this.toolErrors >= this.o.limits.maxToolErrors)
      throw new RunLimitError("max_tool_errors", `工具连续报错 ${this.toolErrors} 次`);
  }
  toolOk() {
    this.toolErrors = 0;
  }
}
