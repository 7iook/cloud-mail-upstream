export const E2E_HOST = '127.0.0.1'
export const E2E_PORT = 8788
export const E2E_ORIGIN = `http://${E2E_HOST}:${E2E_PORT}`
export const E2E_CONTROL_SECRET = 'e2e-local-control-secret'
export const E2E_JWT_SECRET = 'e2e-local-jwt-secret'
export const E2E_CONTROL_HEADER = 'x-e2e-secret'
export const OWNER_EMAIL = 'e2e-owner@example.com'
export const MAILBOX = 'e2e-box@example.com'
export const MAILBOX_2 = 'e2e-box-2@example.com'
export const SENDER_EMAIL = 'e2e-sender@example.com'
export const SENDER_NAME = 'E2E Sender'
export const OTP_CODE = '847291'
// Distinct from OTP_CODE so a multi-mailbox assertion can tell which Tab's code it is.
export const OTP_CODE_2 = '135790'
export const ATTACHMENT_NAME = 'e2e-note.txt'
export const ATTACHMENT_BODY = 'e2e-attachment-bytes'
export const POLL_INTERVAL_MS = 3000
export const LIVE_DELIVERY_TIMEOUT_MS = 10000
