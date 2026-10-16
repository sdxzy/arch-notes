# LLM 限流与容量 demo

```bash
npx tsx sim.ts
```

- `limiter.ts`：RPM+TPM 双令牌桶（预估扣减 + 对账退款）、优先级分道（客服保底池 / 评审 / 草稿 + 老化提升）、重试预算、尊重 Retry-After 的抖动指数退避。
- `sim.ts`：虚拟时钟模拟周一 10 点 300 个 PR 高峰，对比三种模式：A 朴素并发池、B 限流器、C 限流器 + 裁剪 40% 上下文。
