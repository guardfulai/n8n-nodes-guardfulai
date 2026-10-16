import type {
  IAuthenticate,
  ICredentialTestRequest,
  ICredentialType,
  Icon,
  INodeProperties,
} from "n8n-workflow";

import {
  normalizeOrigin,
  REQUEST_TIMEOUT_MS,
} from "../nodes/GuardfulAI/transport";
import { contractError, presentError } from "../nodes/GuardfulAI/errors";

export class GuardfulAIApi implements ICredentialType {
  name = "guardfulaiApi";

  displayName = "Guardful AI API";

  icon: Icon = {
    light: "file:../nodes/GuardfulAI/guardfulai.svg",
    dark: "file:../nodes/GuardfulAI/guardfulai.dark.svg",
  };

  documentationUrl = "https://www.guardfulai.com/integrations/n8n/";

  properties: INodeProperties[] = [
    {
      displayName: "Service Origin",
      name: "serviceOrigin",
      type: "string",
      default: "https://www.guardfulai.com",
      placeholder: "e.g. https://www.guardfulai.com",
      description:
        "Fixed Guardful AI origin. Plain HTTP is accepted only for loopback development",
    },
    {
      displayName: "API Key",
      name: "apiKey",
      type: "string",
      typeOptions: { password: true },
      default: "",
      description:
        "Scoped key with auth:test, scan:check, and scan_policies:read",
    },
  ];

  authenticate: IAuthenticate = async (credentials, options) => {
    try {
      const origin = normalizeOrigin(credentials.serviceOrigin);
      if (typeof credentials.apiKey !== "string" || !credentials.apiKey.trim())
        throw contractError("credentials_required");
      return {
        ...options,
        baseURL: origin,
        headers: {
          ...options.headers,
          Authorization: `Bearer ${credentials.apiKey}`,
        },
      };
    } catch (error) {
      const detail = presentError(error);
      throw new Error(`${detail.message}. ${detail.description}`);
    }
  };

  test: ICredentialTestRequest = {
    request: {
      method: "GET",
      url: "/v1/auth/test",
      json: true,
      timeout: REQUEST_TIMEOUT_MS,
      disableFollowRedirect: true,
    },
    rules: [
      {
        type: "responseCode",
        properties: {
          value: 401,
          message:
            "Replace the API key with a valid, unexpired Guardful AI key, then test again.",
        },
      },
      {
        type: "responseCode",
        properties: {
          value: 403,
          message:
            "Allow auth:test in the key's allowed operations in Guardful AI Integration keys, then test again.",
        },
      },
      ...[false, undefined, null].map((value) => ({
        type: "responseSuccessBody" as const,
        properties: {
          key: "authenticated",
          value,
          message:
            "Guardful AI did not confirm authentication. Check Service Origin and the API key, then test again.",
        },
      })),
      // n8n supports both rule kinds together; its type declares homogeneous arrays.
    ] as ICredentialTestRequest["rules"],
  };
}
