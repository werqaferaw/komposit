// Dialogs: an app's dialog blocks every script until someone answers it. The AI may only
// acknowledge or cancel. Buttons that save, throw away or replace the person's work are the
// person's to press (in the app). Ported from 1.0.
const NOT_FOR_AGENT = /\b(save|don.?t save|discard|delete|replace|overwrite|revert|erase|remove|quit|close without)\b/i;

/** May an AI press this button by itself? */
export const agentMayPress = (button: string): boolean => !!button && !NOT_FOR_AGENT.test(String(button));
