import {useUserStore} from "@/store/user.js";
import {useSettingStore} from "@/store/setting.js";
import {useAccountStore} from "@/store/account.js";
import {loginUserInfo} from "@/request/my.js";
import {permsToRouter} from "@/perm/perm.js";
import router from "@/router";
import {websiteConfig} from "@/request/setting.js";
import i18n from "@/i18n/index.js";

export function detectPreferredLang(storedLang, navigatorLanguage = '') {
    if (storedLang) {
        return storedLang
    }
    const lang = String(navigatorLanguage || '').split('-')[0]
    return lang === 'zh' ? 'zh' : 'en'
}

export function isAnonymousShareVisit(pathname = '', token = '') {
    return !token && /(?:^|\/)s\/[^/]+/i.test(String(pathname || ''))
}

export async function init() {
    document.title = '\u200B'

    const settingStore = useSettingStore();
    const userStore = useUserStore();
    const accountStore = useAccountStore();

    const token = localStorage.getItem('token');
    settingStore.lang = detectPreferredLang(settingStore.lang, navigator.language)

    i18n.global.locale.value = settingStore.lang

    if (isAnonymousShareVisit(window.location.pathname, token)) {
        return
    }

    let setting = null;

    if (token) {
        const userPromise = loginUserInfo().catch(e => {
            console.error(e);
            return null;
        });

        const [s, user] = await Promise.all([websiteConfig(), userPromise]);
        setting = s;
        settingStore.settings = setting;
        settingStore.domainList = setting.domainList;
        document.title = setting.title;

        if (user) {
            accountStore.currentAccountId = user.account.accountId;
            accountStore.currentAccount = user.account;
            userStore.user = user;

            const routers = permsToRouter(user.permKeys);
            routers.forEach(routerData => {
                router.addRoute('layout', routerData);
            });
        }

    } else {
        setting = await websiteConfig();
        settingStore.settings = setting;
        settingStore.domainList = setting.domainList;
        document.title = setting.title;
    }
}
