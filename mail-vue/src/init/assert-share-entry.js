export function assertShareEntryBootstrap(initSrc) {
    const shareGuard = String(initSrc).search(/isAnonymousShareVisit\s*\(/)
    const firstConfig = String(initSrc).search(/websiteConfig\s*\(/)
    const between = shareGuard >= 0 && firstConfig > shareGuard
        ? String(initSrc).slice(shareGuard, firstConfig)
        : ''
    return {
        ok: shareGuard >= 0 && firstConfig > shareGuard && /\breturn\b/.test(between),
        shareGuard,
        firstConfig
    }
}
