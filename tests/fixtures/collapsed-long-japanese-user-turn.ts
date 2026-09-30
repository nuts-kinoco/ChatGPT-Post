const line =
  "20260929T032438Z-2f2b5c91 長文折りたたみ確認です。既存会話への追記送信が受理されたことを、安全側で判定できるようにするための日本語テスト本文です。内容の途中に空白や改行を含めても、先頭の連続した本文が保持されます。";

export const longJapanesePrompt = Array.from({ length: 22 }, (_, index) =>
  `${index + 1}. ${line}`,
).join("\n");

/** ChatGPT's collapsed display: approximately fourteen body lines, then its UI residue. */
export const collapsedLongJapaneseUserTurn = `${longJapanesePrompt
  .split("\n")
  .slice(0, 14)
  .join("\n")}\n…\n展開`;
