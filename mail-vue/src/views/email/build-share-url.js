export function buildShareUrl(origin, lid, sec) {
    const id = lid == null ? '' : String(lid)
    const secret = sec == null ? '' : String(sec)
    if (!id || !secret) {
        return ''
    }
    const base = String(origin || '').replace(/\/$/, '')
    return `${base}/s/${id}#${secret}`
}
