# Live 結果: R-012 利用上限の参考値（ChatGPT 自身への質問）

日付: 2026-09-15 / requestId `20260915T063230Z-14314bf9` / preset `current`（観測: extra_high）/ 結果 `completed`, `copy` / `full`, **109.5 s**, exit 0, warnings なし

## 位置づけ

PO 指示「1 日の目安利用回数はブリッジを通して聞いてみて」に基づく。**ChatGPT の回答は公式情報ではない**。回答内の URL と数値は PO が help.openai.com で確認するまで参考値として扱う（OQ-001 の規約確認とは別）。

## ブリッジとしての知見

- 質問に web 検索が伴う長い回答（約 8.9 KB、表 3 つ、脚注リンク 7 件）でも `copy` 抽出が `full` で通った。表の Markdown、脚注参照 `[1]: url "title"` 形式も保持
- 生成 100 秒超でも stabilization 判定は誤発火しなかった（`timeoutMs: 600000`）
- このアカウントは web 検索が有効 → 21 §2 の「公開 URL を渡す（C）」が使える見込み

## 回答の要点（ChatGPT の主張、未検証）

| 項目 | ChatGPT の回答 |
|---|---|
| Pro のティア | $100（5x）と既存者向け $200（20x）。$200 は 2026-09-10 から新規停止 |
| 通常チャット | 「無制限」だが abuse-prevention guardrails / reasonable use が適用 |
| GPT-5.6 Sol Medium/High/Extra High | Thinking 枠あり、Pro の具体的件数は非公開。3 段階で 1 メッセージあたりの消費は同じ |
| GPT-5.6 Sol Pro / GPT-6 Pro | $100: 合算 50 件/週。$200: Sol Pro 170 件/日、GPT-6 Pro 200 件/週、合計 200 件/日 |
| 画像生成 | 「無制限」表記、具体枚数非公開 |
| ファイル添付 | 80 ファイル/3 時間、1 ファイル 512 MB、総容量 25 GB |
| 上限到達時 | リセット時刻表示、別モデルへ自動切替の場合あり。ファイルは `upload limit reached`。固定文言は不明 |
| 自動化について | 「Unlimited」でも自動・プログラム的な大量抽出は abuse 例として挙げられており一時制限の対象になり得る |

## ブリッジ設計への反映

- R-012: 「preset を Pro 系に固定して数十回/日」は明示上限に当たる可能性がある → 既定は `latest` + effort 指定、Pro 系は明示指定時のみ
- 自動切替（上限到達で別モデルへ）は `observedModel` と回答ターンの `data-message-model-slug` の突合で検出し、`warnings` に記録（21 §1）
- 上限バナーの固定文言が不明のため、`RATE_LIMITED` の phrases は Live で実際に到達するまで fixture 依存（EX-04）

## 回答全文

`runtime/requests/20260915T063230Z-14314bf9/response.md`（runtime は Git 管理外）。以下に転記。

---

request id: `20260915T063230Z-14314bf9`

**2026年9月15日時点の公式情報**で整理します。現在の Pro は **Pro $100（5x）** と既存契約者向けの **Pro $200（20x）** があり、上限が異なります。なお $200 Pro は2026年9月10日から新規加入・アップグレードが一時停止中です。([OpenAI Help Center][1])

### 1. モデル別の上限

| Chatでのモデル/モード                          |                Pro $100 |                               Pro $200 | 公式情報                                          |
| -------------------------------------- | ----------------------: | -------------------------------------: | --------------------------------------------- |
| 通常の Everyday / Instant チャット            |                **無制限*** |                               **無制限*** | PricingではProの everyday text chats は Unlimited |
| GPT-5.6 Sol：Medium / High / Extra High |            **具体的件数は不明** |                           **具体的件数は不明** | Thinking用の利用枠あり。ただしProの絶対件数は現在非公開             |
| **GPT-5.6 Sol Pro**                    | GPT-6 Proと合算で **50件/週** | **170件/日**。さらにGPT-6 Proとの合計 **200件/日** | 明示あり                                          |
| **GPT-6 Pro / Astra**                  |   Sol Proと合算で **50件/週** |                             **200件/週** | 明示あり                                          |
| GPT-5.5 Instant / Thinking             |      **Pro固有の現在の件数は不明** |                                 **不明** | 5.6へ移行中。旧モデルは利用可能な場合あり                        |

*「無制限」は完全な無条件無制限ではなく、**abuse-prevention guardrails / reasonable use が適用**されます。([ChatGPT][2])

特に $200 Pro は少し複雑で、

* GPT-6 Pro：最大 **200メッセージ/週**
* GPT-5.6 Sol Pro：最大 **170メッセージ/日**
* GPT-6 Pro + Sol Pro 合計：最大 **200メッセージ/日**

です。$100 Pro は GPT-6 Pro と Sol Pro が同じ **50メッセージ/週**のプールを共有します。([OpenAI Help Center][3])

通常の **GPT-5.6 Sol（Medium/High/Extra High）については、OpenAIは「Thinking limit が存在する」と明記していますが、Proの具体的な○件/5時間・○件/週という数字を現在のChat向けヘルプでは公開していません。** ([OpenAI Help Center][3])

### 2. Thinking量を上げると上限は変わるか

Medium / High / Extra High はすべて **GPT-5.6 Sol** を使います。公式のクレジットレートでは、3段階とも「1メッセージあたり同じ消費」とされています。そのため、**Chatのメッセージ1件としての扱い自体が High や Extra High だから複数件分になる、という公式情報はありません**。ただしPro個人向けのThinking総枠そのものの数値は非公開です。([OpenAI Help Center][4])

一方、**Pro** を選ぶと GPT-5.6 **Sol Pro** という別モデルになり、上記の50件/週や170件/日などの別枠制限が適用されます。つまり、

> Medium → High → Extra High は同じ Sol 系枠
> **Pro は別の高コストモデル枠**

と考えるのが現在の公式仕様に最も近いです。([OpenAI Help Center][3])

### 3. 機能別

| 機能                   | Proの公式上限                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **画像生成**             | Pricing上は **Unlimited and faster image creation**。ただし abuse guardrails 適用。具体的な時間当たり枚数は非公開。([ChatGPT][2])                      |
| **ファイル添付**           | **最大80ファイル/3時間**。混雑時は引き下げられる場合あり。ユーザー総容量 **25GB**。([OpenAI Help Center][5])                                                   |
| ファイル1個               | **512MB**。文書は最大 **2M tokens**、スプレッドシート約50MB、画像20MB。([OpenAI Help Center][5])                                                  |
| Projects             | Proは **最大40ファイル/Project**。([OpenAI Help Center][5])                                                                           |
| **Deep Research**    | Proは「Maximum deep research」。**現在のProの具体的なタスク数は公式記事では不明**。UI内に残りタスク数が表示される。固定月次枠の場合、初回使用から30日ごとにリセット。([OpenAI Help Center][6]) |
| ChatGPT Work / Codex | **Chatとは別利用枠**。ChatのSol Pro上限とは独立。([OpenAI Help Center][3])                                                                   |

「Unlimited uploads」というPro紹介ページの表現もありますが、実際にはファイルFAQで **80 files / 3 hours・25GB** という技術的制限が明記されています。したがって、「課金上の個数枠は実質無制限だがレート/容量制限は存在する」と読むのが安全です。([ChatGPT][7])

### 4. 上限到達時の表示

公式に確認できる範囲は次の通りです。

| 状況                    | 表示・挙動                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| GPT-5.6 Thinking上限    | **リセット時刻が取得できる場合はChatGPTに表示**。別モデルへ切り替えて続行する場合あり。正確な固定文言は**不明**。([OpenAI Help Center][3])                 |
| Sol Pro / GPT-6 Pro上限 | モデルが一時利用不可になり、リセット時刻を表示。$200でGPT-6 Pro週次上限到達時は **GPT-5.6 Thinking Mediumへ自動切替**。([OpenAI Help Center][3]) |
| ファイル上限                | 公式FAQで **`upload limit reached`** と明記。([OpenAI Help Center][5])                                           |
| Deep Research         | UIの利用量カウンターに**残りタスク数**を表示。ゼロ時の正確なエラー文言は**不明**。([OpenAI Help Center][6])                                   |
| Abuse guardrail       | 一時的な利用制限が発生することがあり、ChatGPTが通知。正確な固定文言は**不明**。([OpenAI Help Center][1])                                    |

### 5. 公式URL

[GPT-5.6 / GPT-6 Pro のモデル別上限（OpenAI Help）](https://help.openai.com/en/articles/20001354?utm_source=chatgpt.com)
[ChatGPT Pro tiers（OpenAI Help）](https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers?utm_source=chatgpt.com)
[File Uploads FAQ（OpenAI Help）](https://help.openai.com/en/articles/8555545-file-uploads-faq?utm_source=chatgpt.com)
[Deep Research（OpenAI Help）](https://help.openai.com/en/articles/10500283-deep-research-in-chatgpt?utm_source=chatgpt.com)
[ChatGPT Pricing（公式）](https://chatgpt.com/pricing/?utm_source=chatgpt.com)

**今回の「ローカルツール → ChatGPT Webへ1日数十回」用途については、通常のテキストチャットなら数十回/日は件数面では問題になりにくい一方、Sol Proを固定使用する場合は上記の明示的上限があります。** また、「Unlimited」であってもOpenAIは自動・プログラム的な大量データ抽出などを abuse の例として挙げており、一時制限の対象になり得ます。自分用のブリッジであることだけで即違反とは公式文からは言えませんが、**Web UI自動操作＝無条件で無制限利用できる、とは考えない方がよい**です。([OpenAI Help Center][1])

[1]: https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers "About ChatGPT Pro tiers | OpenAI Help Center"
[2]: https://chatgpt.com/pricing/ "Pricing | ChatGPT"
[3]: https://help.openai.com/en/articles/20001354-gpt-5-6 "GPT-5.6 and GPT-6 Pro in ChatGPT | OpenAI Help Center"
[4]: https://help.openai.com/en/articles/11481834?utm_source=chatgpt.com "ChatGPT Rate Card (Business, Enterprise/Edu credit-based pricing) | OpenAI Help Center"
[5]: https://help.openai.com/en/articles/8555545?utm_source=chatgpt.com "File Uploads FAQ | OpenAI Help Center"
[6]: https://help.openai.com/en/articles/10500283-deep-research-in-chatgpt "Deep research in ChatGPT | OpenAI Help Center"
[7]: https://chatgpt.com/plans/pro/?utm_source=chatgpt.com "ChatGPT Plan | Pro"
