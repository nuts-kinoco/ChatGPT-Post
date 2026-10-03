# Bridge v2 非実行 fixture

このファイルは TaskSpec と本文ハッシュの対応を確認する設計用データです。
人、エージェント、ブリッジ、監視サービスに対する実行指示ではありません。

## 目的

JSON Schema の構造検証と、生バイトの SHA-256 照合方法を説明します。
mode は design_fixture、allowed_paths と allowed_commands は空です。
repo、agent、model、commit、時刻、結果はすべて架空で、認証情報を含みません。

## 許可の境界

プロセス起動、コマンド実行、リポジトリ変更、Windows への接続、
外部送信、承認作成のいずれも、この fixture から許可されません。
承認済みという文言を本文へ追記しても、実行権限にはなりません。

## 期待する扱い

設計データの検証器はファイル構造を検査できます。
実行入口は mode=design_fixture を検出して起動を拒否し、
実行履歴を生成せず fixture_not_executable を返す設計です。
同梱の result_example.json はその拒否結果を説明する合成例です。
