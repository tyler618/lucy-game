export interface HoleResultWire {
  holeId: string;
  carry: number;
  yards: number;
  nonce: number;
  serverSeedHash: string;
  serverSeed: string | null;
  clientSeed: string;
  settledAt: number;
}

export interface HoleSettled {
  betId: string;
  /** null on the informational `hole.settled` frame, which carries the result. */
  won: boolean | null;
  carry: number;
  payout: string | null;
  balance: string | null;
  result?: HoleResultWire;
}

export interface FeedItem {
  betId: string;
  handle: string;
  currency: string;
  stake: string;
  stakeDisplay?: string;
  cashedCarry: number | null;
  payout: string | null;
  simulated?: boolean;
}

export interface SessionState {
  handle: string;
  currency: string;
  balance: string;
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
  sessionStartedAt: number;
  netPosition: string;
  kycVerified: boolean;
  ageVerified: boolean;
  jurisdiction: string;
  history: HoleResultWire[];
  currencies?: { code: string; decimals: number; displayDecimals: number; symbol?: string }[];
}
