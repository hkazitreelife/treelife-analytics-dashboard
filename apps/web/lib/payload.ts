import { getPayload, type Payload } from "payload";

import config from "@payload-config";

export const getPayloadClient = async (): Promise<Payload> =>
  getPayload({ config });
