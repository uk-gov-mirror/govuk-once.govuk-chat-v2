import { vi } from 'vitest';

export const send = vi.fn();

// ElectroDB sends every request through the document client we construct,
// as a command whose input is the request. Only the client is replaced.
// ElectroDB requires the SDK's command classes itself, so tests receive
// real commands and assert on their input.
export function stubDynamoDBDocumentClient(): void {
  vi.doMock('@aws-sdk/lib-dynamodb', () => ({
    DynamoDBDocumentClient: {
      from: vi.fn().mockImplementation(function () {
        return { send };
      }),
    },
  }));
}
