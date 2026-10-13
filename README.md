# arch-notes
零构建静态站。新增一天：
1. `notes/<slug>.md` 放笔记；2. `demos/<slug>/` 放 demo，`demos/<slug>.zip` 放压缩包；
3. 在 `notes.json` 追加 `{"slug","date","title","tags","summary",["files"]}`；4. push。

## 写作约定
- **Callout**：h2/h3 标题含「Bad Case / 翻车」渲染为红色，「Review / 审」为绿色，「vs / 取舍」为琥珀色；引用块（`>`）为蓝色信息框。
- **复习题 / Review 追问必须附可折叠参考答案**，格式如下（`<summary>` 后和 `</details>` 前要留空行，里面才能写 markdown）：

```markdown
**1. 问题？**

<details><summary>参考答案</summary>

- 答案要点，可以用 **markdown** 和 `code`

</details>
```
