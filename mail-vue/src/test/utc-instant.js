import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
import { expect } from 'vitest'

dayjs.extend(utc)
dayjs.extend(timezone)

// 浏览器时区由跑测机器决定，所以断言不能钉死渲染出来的字面量。渲染的是「本机时区的墙上时钟」，
// 把它按本机时区读回物理瞬时，必须等于后端裸串按 UTC 读出的瞬时 —— 这个等式与跑测时区无关。
// 局限：跑测机器本身就是 UTC 时两边恒等，这条断言抓不到「忘了转换」；Cloudflare 部署面对的
// 恰恰是「后端 UTC、浏览器非 UTC」，所以本机（UTC+8）才是有判别力的那一侧。
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone

export function expectSameInstant(shown, utcBare) {
    const wallClock = String(shown).trim()
    expect(dayjs.tz(wallClock, zone).valueOf()).toBe(Date.parse(`${utcBare.replace(' ', 'T')}Z`))
}
