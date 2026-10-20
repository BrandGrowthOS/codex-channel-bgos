export interface BrowserProfileConfiguration {
  backendUrl: string;
  pairingToken: string;
  pairingId: number;
  ownerUserId: string;
  assistantIds: readonly number[];
  directory: string;
  parentPid: number;
}
export function configuration(raw: unknown): Readonly<BrowserProfileConfiguration>;
