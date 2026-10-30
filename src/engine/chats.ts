// The reserved (pseudo) chat ids an order or a message is recorded under. A leaf module with no
// imports, so the ledger and the task history (ADR-0066) read them without an import cycle through
// dispatch.ts, which re-exports them. Real operator chats are Telegram ids; 0 is the web console.

/** Reserved chat id for dispatched sub-projects, so they never hijack the operator's free-text
 *  routing (which always falls back to the default project). */
export const SUB_CHAT = -2;
/** Reserved chat id for company runs driven by a customer brief (never a real operator chat). */
export const CUSTOMER_CHAT = -3;
/** The pseudo-chat side-lane orders are recorded under (ADR-0057): never the folder's resume point,
 *  reload snapshot or consult fork, which all read SUB_CHAT. */
export const SIDE_CHAT = -5;
