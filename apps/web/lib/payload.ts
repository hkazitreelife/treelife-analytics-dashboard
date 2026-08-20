import { getPayload, type Payload } from "payload";

import config from "@payload-config";

declare global {
  // eslint-disable-next-line no-var
  var __payloadClientPromise: Promise<Payload> | undefined;
}

export const getPayloadClient = async (): Promise<Payload> => {
  if (!globalThis.__payloadClientPromise) {
    globalThis.__payloadClientPromise = getPayload({ config });
  }
  return globalThis.__payloadClientPromise;
};
