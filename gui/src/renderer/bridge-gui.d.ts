import type { BridgeGuiState } from "../main/state.js";
import type { RequestDetail } from "../main/main.js";
declare global { interface Window { bridgeGui: { onState(callback: (state: BridgeGuiState) => void): () => void; togglePopup(): void; requestDetail(requestId: string): Promise<RequestDetail | { error: string }>; openConversation(requestId: string): Promise<boolean>; }; } }
export {};
