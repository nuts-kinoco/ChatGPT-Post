# claude_cli_probe

Claude CLI の挙動を確認するための小さな開発者向け診断コマンドです。標準ライブラリのみを使用し、追加の依存はありません。

## オフライン実行(デフォルト)

```
python claude_cli_probe.py
```

同梱の架空 JSON(`fixtures/offline-result.json`)を読むだけです。Claude は起動しません。出力される公開サマリーの項目は次のとおりです。

- `requested_model`: 要求したモデルのエイリアス。実際のモデル名とは別の項目です。
- `actual_models` / `resolved`: `modelUsage` のキーのみから導出します。エイリアスから推測することはありません。
- `mode`: デフォルトは `offline_fixture` で、この実行中の `launch_attempts` は 0 です。架空fixture内の参考試行数は `fixture_recorded_launch_attempts` に分けて表示します。
- `status` / `exit_code` / `timed_out`: 終了状態とタイムアウトの別々の事実です。
- `response_exact_match`: 期待する応答との完全一致です。
- `elapsed_seconds` / `timeout_seconds`: 経過時間と上限です。
- `launch_attempts`: モデル起動の試行回数です。
- `configured_max_turns` と `returned_num_turns`: 設定値と返却値は別の事実です。`--max-turns` が API リクエスト回数と一致する、あるいはそれを証明する、とは主張しません。

## ライブ実行(明示的なオプトイン)

`--live` と `--confirm-live` の両方が必要です。片方だけではエラーになり、起動しません。

```
python claude_cli_probe.py --live --confirm-live ^
  --cli-path C:\path\to\claude.exe --cli-version "<caller-supplied>" ^
  --model sonnet --prompt "Reply with PONG" --expected-response PONG ^
  --private-parent C:\path\to\private-dir --max-turns 3 --timeout 60
```

起動前に次を検証します。

- CLI は絶対パスで実在する実行ファイルであること
- バージョン文字列が指定されていること
- モデルが 1 つであること
- プロンプトと期待応答が指定されていること
- private-parent が既存のディレクトリであること
- max-turns が 1〜12、timeout が 1〜180 であること

Windows ではこのコマンドと helper は親ディレクトリの ACL を検査・変更しません。利用者が private-parent を他者に共有されない場所に用意してください。

モデル呼び出しは `probe_once.run_once` を 1 回だけ呼びます。引数には `--safe-mode --restricted --tools "" --strict-mcp-config --disallowedTools mcp__*`、モデル、`--effort low`、`--max-turns`、JSON 出力、`--no-session-persistence`、ユーザープロンプトが含まれます。

### 記録

- 生の stdout/stderr は helper の private な実行ディレクトリ(`probe-*`)に残ります。
- 同じディレクトリの `report.json`(private)に次を保存します: CLI の絶対パス、指定されたバージョン、要求エイリアス、max-turns、返却 num_turns、timeout、起動試行回数、子 PID と回収状況、実際のモデル、応答一致。
- 標準出力の公開サマリーには、認証情報、ユーザー名、メール、UUID/セッション ID、生ログ、パス、PID を含めません。

## テスト

```
python -m unittest test_claude_cli_probe -v
```

架空のペイロードのみを使い、helper はモックします。ライブ呼び出しは行いません。

## 制限

- オプトインのみです。通常の CLI の認証と権限の制御はそのまま有効です。このツールは認証ファイルを読まず、認証情報も設定せず、ログイン、API キー、フォールバックモデル、権限バイパス、セキュリティ設定の機能もありません。
- プロセスツリーの封じ込めはありません(直接の子プロセスのみを扱います)。クラッシュ耐性のある永続化も保証しません。
- このツールは Bridge や R3 helper を検証も完成もしません。
