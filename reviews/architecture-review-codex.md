## Executive summary

既反映の二重送信・完了判定・stale lock 指摘は除外しました。そのうえで、通常プロファイル保護の Windows reparse point 回避、診断成果物失敗時に `result.json` を失う経路、preset 観測契約の fail-closed 不備が残っています。これらは MVP の絶対条件（専用プロファイル、失敗を成功としない、モデル確認）に直接触れます。Phase 4 着手前に設計を補正すべきであり、現時点では vertical slice へ進める判断は推奨しません。

| ID | Severity | File §section | Evidence | Impact | Recommendation |
|---|---|---|---|---|---|
| F-01 | High | `15-SECURITY-AND-PRIVACY.md` §5 | 「**正規化した絶対パス**を検査し…通常 User Data を拒否」 | パス正規化だけでは NTFS junction / symlink などの reparse point を解決しない。専用ディレクトリに見えるパスが通常 Chrome の `User Data` を指せば、CON-004 / SEC-001 を迂回して通常プロファイルを自動化できる。 | `realpath` 後の canonical path 比較に加え、profile path の全祖先・最終要素の reparse point を fail closed で拒否する。初回作成時も同じ検証を行う。 |
| F-02 | High | `11-STATE-MACHINE.md` §1, §4 | 「ある effect が…イベントを生じた時点で残りの effects は実行しない」／`FAIL_AFTER_BROWSER = CAPTURE, STOP_TRACE, WRITE_RESULT...` | screenshot 保存、trace 停止・サニタイズ、または artifact ディレクトリ作成が失敗すると、列挙順では `WRITE_RESULT` に到達しない。ブラウザ起動後の失敗で `result.json` を返せず、呼び出し元は状態・`submitted` を判定できない。 | 診断 artifact は明示的に best-effort とし、失敗しても必ず `WRITE_RESULT` と終了処理へ進む effect 意味論にする。artifact 失敗を注記する結果表現と、CAPTURE / STOP_TRACE 失敗注入テストを追加する。 |
| F-03 | High | `schemas/result.schema.json`, `12-IO-CONTRACT.md` §3.3 | `$defs.preset` は `current` を含み、`observedPreset` も同じ型を参照する。 | `requestedPreset: "current", observedPreset: "current", status: "completed"` が契約上有効になる。しかし `current` は「現在値を変更しない」という要求指定であり、観測済みのモデル／effort ではない。実際の選択を確認せず completed を返す余地ができ、CON-007 の fail closed を弱める。 | `RequestedPreset` と `ObservedPreset` を別 enum にし、後者から `current` を除く。Auto 系を許可するなら OQ-009 の PO 判断後にのみ観測専用値を追加する。 |
| F-04 | Medium | `schemas/result.schema.json`, `13-ERROR-MODEL.md` §2 | schema は `manual_intervention_required` の code だけを制限する一方、§2 は各 code の status を一意に定義する。 | 例えば `status: "failed"` と `error.code: "AUTH_REQUIRED"` が schema 上通る。機械可読契約を正とする `12` §3 の説明と矛盾し、呼び出し元が status / code の組を安全に解釈できない。 | `status` ごとの `error.code` を `oneOf` で完全に制約する。少なくとも writer 側 invariant で全 code-status 組を拒否し、否定ケースを schema テストへ追加する。 |
| F-05 | Medium | `15-SECURITY-AND-PRIVACY.md` §7, `17-OPERATIONS.md` §8 | §7: 「`runtime/` 配下は…任意に削除してよい（削除しても Bridge の動作に影響しない）」／§8: marker を削除すると「同じ requestId の再実行が拒否されなくなる」。 | 一般的な runtime クリーンアップが、送信済み requestId の唯一のグローバル記録を消す。別ディレクトリから同じ requestId を実行すれば再送可能となり、R-003 の防御を運用手順自身が無効化する。 | `runtime/state/` を一般削除対象から除外し、marker を送信監査台帳として扱う。将来 GC するなら、グローバルな完了台帳を残したまま、明示承認付きで行う。 |
| F-06 | Medium | `10-ARCHITECTURE.md` §4, `12-IO-CONTRACT.md` §1, `04-ACCEPTANCE-CRITERIA.md` AC-008 | run の事前存在確認は `requestDir/result.json` のみ。AC-008 は「`completed` 以外では…`response.md` が存在しない」。 | `result.json` が無い request directory に古い／手動作成の `response.md` が残っている場合、認証失敗等でも stale response が残る。status を読まない呼び出し元に成功と誤認させ、AC-008 にも反する。 | browser 起動前に `response.md` の既存を拒否するか、request directory を新規・空に限定する。既存 response を削除する設計にはせず、衝突として安全停止する。 |
| F-07 | Medium | `10-ARCHITECTURE.md` §4 steps 12–15, `02-REQUIREMENTS.md` FR-016(e) | preset 再観測は step 12、次に lock 再検証・marker fsync を経て step 15 で click。 | baseline 観測後、クリック前に SPA や利用上限処理で表示 preset が変化しても、保持 Locator は再解決され得る。そのまま異なる preset で送信する race が残る。 | marker 作成後・click 直前にも preset を再観測し、不一致なら click しない。marker は残しつつ、送信なしを確定した `MODEL_NOT_VERIFIABLE` の終端を定義する。 |

## Missing acceptance tests

- 通常 Chrome `User Data` を指す junction / symlink / reparse point を `--profile-dir` に渡して `INVALID_CONFIG` になること。
- `CAPTURE`、trace sanitizer、artifact directory の各失敗でも、正しい `submitted` を含む `result.json` が必ず残ること。
- `completed + observedPreset: current`、および code-status 不整合が schema / invariant で拒否されること。
- `result.json` 無しで既存 `response.md` がある request directory を安全に拒否し、送信しないこと。
- `SNAPSHOT_BASELINE` 後、marker 作成前後に preset 表示が変化する fixture で、送信 click が一度も呼ばれないこと。
- `runtime/state/<requestId>/submit.marker` を削除した場合の危険性を、doctor / 運用手順が明示的に警告すること。

## Architecture alternatives worth reconsidering

- Phase 4 は `preset: current` を使わず、実 UI で一意に検証済みの named preset だけを許可する。
- `submit.marker` だけでなく、requestId ごとのグローバル終端台帳を持ち、request directory 外からの同一 ID 再実行も恒久的に拒否する。
- profile directory は任意パス指定を許すより、bridge 管理 root 配下の新規専用ディレクトリだけを受け入れる設計に寄せる。

## Verdict

**Do not ship — Phase 4 vertical slice への進行は保留。**

少なくとも F-01〜F-03 を設計・受入条件・テスト戦略で閉じてから進めるべきです。