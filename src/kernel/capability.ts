export interface CapabilityToken<T> {
  readonly id: string;
  readonly multiple: boolean;
  readonly __type?: T;
}

export function capability<T>(id: string): CapabilityToken<T> {
  return Object.freeze({ id: validateId(id), multiple: false });
}

export function multiCapability<T>(id: string): CapabilityToken<T> {
  return Object.freeze({ id: validateId(id), multiple: true });
}

function validateId(id: string): string {
  const normalized = id.trim();
  if (!normalized) throw new Error("Capability id cannot be empty");
  return normalized;
}
