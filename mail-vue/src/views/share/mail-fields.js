export function senderLine(item) {
    const name = item && item.senderName ? String(item.senderName) : ''
    const addr = item && item.senderAddress ? String(item.senderAddress) : ''
    if (name && addr) {
        return `${name} <${addr}>`
    }
    return name || addr
}
