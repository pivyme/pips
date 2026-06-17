// Shared API DTOs (the wire shape between backend and web). DUSDC amounts cross the wire
// as human-readable decimal strings, never raw 6dp integers or JS numbers. See 02-API.md.

export interface UserDTO {
  id: string;
  address: string; // Sui address (zkLogin or dev wallet)
  displayName: string; // generated handle, e.g. "Lucky Otter"
  provider: 'enoki' | 'dev';
  balance: string; // DUSDC, e.g. "983.50"
  managerReady: boolean; // PredictManager exists
  settings: { sound: boolean; haptics: boolean; reducedMotion: boolean };
}
