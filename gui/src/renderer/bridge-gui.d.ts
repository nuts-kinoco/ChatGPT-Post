import type { BridgeGuiState } from "../main/state.js";
declare global { interface Window { bridgeGui: { onState(callback: (state: BridgeGuiState) => void): () => void; togglePopup(): void; }; } }
export {};
