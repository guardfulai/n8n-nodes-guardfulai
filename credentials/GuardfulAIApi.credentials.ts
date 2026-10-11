import type {
  IAuthenticateGeneric,
  ICredentialType,
  Icon,
  INodeProperties,
} from "n8n-workflow";

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

  authenticate: IAuthenticateGeneric = {
    type: "generic",
    properties: {
      headers: {
        Authorization: "=Bearer {{$credentials.apiKey}}",
      },
    },
  };
}
