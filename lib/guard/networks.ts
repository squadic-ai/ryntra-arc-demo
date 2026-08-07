/**
 * Arc network registry.
 *
 * Everything that differs between one Arc network and another lives here as
 * data: chain id, RPC endpoints, explorer, token addresses, decimals, and
 * whether the network carries real value. Nothing downstream may hard-code a
 * network fact.
 *
 * This is not tidiness. Two separate defects in one session came from network
 * facts typed by hand: an RPC host that a whole country cannot reach, and a
 * chain id whose hex digits were transposed into a chain that does not exist.
 * Both were invisible to the type system and one of them was enshrined by a
 * test. Derived-from-one-source is the only shape that removes that class.
 *
 * It is also what makes the product honest about its future. Adding mainnet is
 * a registry entry, not a rewrite — but the entry is `DESIGNED` and cannot be
 * selected, because a network switch is not what makes mainnet safe. Canon
 * Gate D requires verified production contract addresses, real liquidity, hard
 * limits, a kill switch, rollback, monitoring, an incident runbook, and a fully
 * reconciled manual canary. The registry is the mechanism; the gate is the
 * permission.
 */

export type ArcNetworkStatus =
  /** Configured, verified and selectable. */
  | "ACTIVE"
  /** Present in the model so the shape is real, but not selectable. */
  | "DESIGNED";

export type ArcTokenDefinition = {
  /** ERC-20 interface address. */
  address: `0x${string}`;
  /** Decimals of the ERC-20 interface. Arc's native view of USDC uses 18. */
  decimals: number;
  symbol: string;
};

export type ArcNetwork = {
  id: string;
  label: string;
  shortLabel: string;
  status: ArcNetworkStatus;
  /** The single source for every chain identifier below. */
  chainId: number;
  /** Circle App Kit's own name for the network. */
  appKitChain: string;
  explorerBaseUrl: string;
  rpc: {
    /** The network operator's own endpoint. */
    primary: string;
    /** Documented provider mirrors, in the operator's published order. */
    mirrors: readonly string[];
  };
  nativeCurrency: { name: string; symbol: string; decimals: number };
  tokens: { usdc: ArcTokenDefinition; eurc?: ArcTokenDefinition };
  /** True only for a network where a mistake costs real money. */
  carriesRealValue: boolean;
  /** Why this network is not selectable, when it is not. */
  gate: string | null;
};

/** CAIP-2 chain reference. Derived, never typed. */
export function chainRefFor(network: ArcNetwork): string {
  return `eip155:${network.chainId}`;
}

/** The hex chain id a wallet expects. Derived, never typed. */
export function hexChainIdFor(network: ArcNetwork): `0x${string}` {
  return `0x${network.chainId.toString(16).toUpperCase()}` as `0x${string}`;
}

/** CAIP-19 asset reference for a token on this network. Derived, never typed. */
export function assetRefFor(network: ArcNetwork, token: ArcTokenDefinition): string {
  return `${chainRefFor(network)}/erc20:${token.address}`;
}

export function explorerTransactionUrl(network: ArcNetwork, transactionHash: string): string {
  return `${network.explorerBaseUrl}/tx/${transactionHash.toLowerCase()}`;
}

/** Every RPC endpoint the network operator publishes, primary first. */
export function publishedRpcEndpoints(network: ArcNetwork): readonly string[] {
  return [network.rpc.primary, ...network.rpc.mirrors];
}

export const ARC_TESTNET_NETWORK: ArcNetwork = {
  id: "arc-testnet",
  label: "Arc Testnet",
  shortLabel: "Testnet",
  status: "ACTIVE",
  chainId: 5_042_002,
  appKitChain: "Arc_Testnet",
  explorerBaseUrl: "https://testnet.arcscan.app",
  rpc: {
    primary: "https://rpc.testnet.arc.io",
    /* Arc publishes these alongside the primary. They are not a workaround:
       the primary refuses entire countries at its WAF, so a build that knows
       only the primary is unusable from a blocked region. */
    mirrors: [
      "https://rpc.blockdaemon.testnet.arc.io",
      "https://rpc.drpc.testnet.arc.io",
      "https://rpc.quicknode.testnet.arc.io",
    ],
  },
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  tokens: {
    usdc: { address: "0x3600000000000000000000000000000000000000", decimals: 6, symbol: "USDC" },
    eurc: { address: "0x89b50855aa3be2f677cd6303cec089b5f319d72a", decimals: 6, symbol: "EURC" },
  },
  carriesRealValue: false,
  gate: null,
};

/**
 * Arc mainnet is modelled, not configured.
 *
 * The entry exists so the shape of the system is the real one and adding
 * mainnet is a data change. Every value that must come from verified official
 * sources is deliberately absent, and the network is not selectable. Filling
 * these in is not the same as passing Gate D, and doing one without the other
 * is exactly the mistake this record is here to prevent.
 */
export const ARC_MAINNET_NETWORK: ArcNetwork = {
  id: "arc-mainnet",
  label: "Arc",
  shortLabel: "Mainnet",
  status: "DESIGNED",
  chainId: 0,
  appKitChain: "",
  explorerBaseUrl: "",
  rpc: { primary: "", mirrors: [] },
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  tokens: { usdc: { address: "0x0000000000000000000000000000000000000000", decimals: 6, symbol: "USDC" } },
  carriesRealValue: true,
  gate:
    "Arc mainnet is not configured. It requires verified official chain and contract parameters, confirmed liquidity for the exact operation, hard limits, a kill switch, rollback, monitoring, an incident runbook, and a fully reconciled manual canary (canon Gate D). A network switch is not what makes mainnet safe.",
};

export const ARC_NETWORKS: readonly ArcNetwork[] = [ARC_TESTNET_NETWORK, ARC_MAINNET_NETWORK];

export function findArcNetwork(id: string): ArcNetwork | undefined {
  return ARC_NETWORKS.find((network) => network.id === id);
}

/**
 * Select the network this process runs against.
 *
 * A network that is not `ACTIVE` cannot be selected, and asking for it is an
 * error naming the gate rather than a silent fall back to testnet. Falling back
 * would be worse than failing: an operator who believed they had switched to
 * mainnet would keep transacting on a network with no real value and never know.
 */
export function resolveArcNetwork(
  env: Record<string, string | undefined> = process.env,
): ArcNetwork {
  const requested = env.ARC_NETWORK?.trim();
  if (!requested) return ARC_TESTNET_NETWORK;
  const network = findArcNetwork(requested);
  if (!network) {
    throw new Error(
      `ARC_NETWORK "${requested}" is not a known Arc network. Known: ${ARC_NETWORKS.map((item) => item.id).join(", ")}.`,
    );
  }
  if (network.status !== "ACTIVE") {
    throw new Error(`ARC_NETWORK "${requested}" is not selectable. ${network.gate ?? ""}`.trim());
  }
  return network;
}

/**
 * Resolve the RPC endpoint for server-side reads.
 *
 * `ARC_TESTNET_RPC_URL` keeps working as the explicit override; otherwise the
 * network's own primary is used. An override must be an absolute HTTPS URL: a
 * settlement path must never read chain state from an endpoint the operator did
 * not mean to use, so a malformed or downgraded value throws instead of
 * quietly falling back.
 */
export function resolveArcRpcUrl(
  network: ArcNetwork,
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env.ARC_TESTNET_RPC_URL?.trim() || env.ARC_RPC_URL?.trim();
  if (!configured) return network.rpc.primary;
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error("The configured Arc RPC URL must be an absolute URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("The configured Arc RPC URL must use https.");
  }
  return configured;
}
