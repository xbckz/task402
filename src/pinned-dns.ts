export interface PinnedAddress {
  address: string;
  family: number;
}

/** Return the shape Node's lookup callback expects for the requested mode. */
export function pinnedLookupValue(address: PinnedAddress, all: boolean): string | PinnedAddress[] {
  return all ? [address] : address.address;
}
