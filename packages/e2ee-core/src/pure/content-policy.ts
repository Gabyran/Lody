import { Either } from 'effect';
import type { OrgState } from './ledger-state';
import type { ContentHeader } from './content-frame';
import { ContentError } from './errors';
import { keyId } from './identifiers';

/** Only active personal/machine devices of non-guest members may write content. */
export function deviceMayWriteDocument(state: OrgState, deviceIdHex: string): boolean {
  const device = state.devices.get(deviceIdHex);
  if (!device || (device.kind !== 'personal' && device.kind !== 'machine')) return false;
  const member = state.members.get(keyId(device.membershipId));
  return member !== undefined && member.role !== 'guest';
}

/**
 * The signing key for a content header, taken only from verified ledger authority.
 * A current device must match the header's Org, member instance and user. A device
 * admitted earlier and since revoked (`wasAdmitted`) still verifies as a historical
 * author, but its identity claims cannot be checked against current state. Keys never
 * admitted to this Org are refused. Current write permission is a separate check.
 */
export function contentAuthorKey(
  state: OrgState,
  header: Pick<ContentHeader, 'genesis' | 'actor' | 'memberInstance' | 'device'>,
  wasAdmitted: (deviceIdHex: string) => boolean = () => false
): Either.Either<string, ContentError> {
  const refuse = Either.left(new ContentError({ code: 'unauthorized' }));
  if (header.genesis !== keyId(state.genesis)) return refuse;
  const device = state.devices.get(header.device);
  if (!device) return wasAdmitted(header.device) ? Either.right(header.device) : refuse;
  const member = state.members.get(keyId(device.membershipId));
  if (
    !member ||
    header.memberInstance !== keyId(device.membershipId) ||
    header.actor !== keyId(member.userId)
  )
    return refuse;
  return Either.right(header.device);
}
