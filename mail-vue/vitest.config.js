import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config.js'

function withoutPwa(plugins) {
    return (plugins || []).flat(Infinity).filter((plugin) => {
        const name = plugin && plugin.name ? String(plugin.name) : ''
        return !name.toLowerCase().includes('pwa')
    })
}

export default defineConfig(async () => {
    const resolved = await Promise.resolve(
        typeof viteConfig === 'function'
            ? viteConfig({
                command: 'serve',
                mode: 'test',
                isSsrBuild: false,
                isPreview: false
            })
            : viteConfig
    )

    return mergeConfig(
        {
            ...resolved,
            plugins: withoutPwa(resolved.plugins),
            build: {
                ...(resolved.build || {}),
                outDir: 'dist',
                emptyOutDir: false
            }
        },
        {
            test: {
                environment: 'jsdom',
                globals: false,
                setupFiles: ['./src/test/setup.js'],
                include: ['src/**/*.{test,spec}.{js,ts}'],
                exclude: [
                    '**/node_modules/**',
                    '**/dist/**'
                ],
                server: {
                    deps: {
                        inline: ['element-plus']
                    }
                }
            }
        }
    )
})
