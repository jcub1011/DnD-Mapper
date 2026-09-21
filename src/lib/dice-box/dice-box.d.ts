export interface DiceBoxColorset {
  name: string;
  background: string;
  foreground: string;
  texture?: string;
  material?: string;
}

export interface DiceBoxOptions {
  assetPath?: string;
  theme_customColorset?: DiceBoxColorset | null;
  theme_surface?: string;
  theme_material?: string;
  baseScale?: number;
  gravity_multiplier?: number;
  strength?: number;
  shadows?: boolean;
  sounds?: boolean;
  onRollComplete?: ((results: unknown) => void) | null;
}

export default class DiceBox {
  constructor(container: string | HTMLElement, options?: DiceBoxOptions);
  initialize(): Promise<void>;
  roll(notation: string): Promise<unknown>;
  reroll(diceIndices: number[]): Promise<unknown>;
  add(notation: string): Promise<unknown>;
  remove(diceIndices: number[]): Promise<unknown>;
  clearDice(): void;
  updateConfig(options: Partial<DiceBoxOptions>): Promise<void>;
  setDimensions(dimensions?: { x?: number; y?: number }): void;
  container: HTMLElement;
  renderer?: { domElement?: HTMLCanvasElement };
  sounds: boolean;
  baseScale: number;
  onRollComplete: ((results: unknown) => void) | null;
  onAddDiceComplete?: ((results: unknown) => void) | null;
}
