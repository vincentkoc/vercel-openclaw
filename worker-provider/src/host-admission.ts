import { appendFileSync, readFileSync } from 'node:fs';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { getPluginRuntimeGatewayRequestScope } from 'openclaw/plugin-sdk/plugin-runtime';

type Admission = { sessionKey: string; messageId: string; senderId: string; eventId: string; expiresAt: number };

export function registerHostAdmission(api: OpenClawPluginApi, path: string): void {
  const read = (): Admission => JSON.parse(readFileSync(path, 'utf8'));
  const record = (type: string, admission: Admission, extra = {}) => appendFileSync(`${path}.events`, `${JSON.stringify({ type, eventId: admission.eventId, at: Date.now(), ...extra })}\n`, { mode: 0o600 });
  api.on('before_dispatch', event => {
    try {
      const admission = read();
      if (admission.expiresAt > Date.now() && event.sessionKey === admission.sessionKey && event.messageId === admission.messageId && event.senderId === admission.senderId) {
        const scope = getPluginRuntimeGatewayRequestScope();
        record('admitted', admission, { callerScopes: scope?.client?.connect.scopes, callerId: scope?.client?.connect.client.id, callerMode: scope?.client?.connect.client.mode });
        return { handled: false };
      }
    } catch { /* Missing admission must never allow a local turn. */ }
    return { handled: true, text: 'This conversation has no admitted remote execution worker.' };
  });
  api.on('message_sent', (event, ctx) => {
    const admission = read();
    if (ctx.channelId === 'slack' && ctx.sessionKey === admission.sessionKey) record(event.success ? 'delivered' : 'delivery-failed', admission, { messageId: event.messageId });
  });
}
