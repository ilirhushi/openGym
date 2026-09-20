import { describe, expect, it } from 'vitest'
import { LANGS, DERIVED_LOCALES } from './i18n-core.js'
import { PT_BR_OVERRIDES } from '../locales/pt-BR.js'

const PACK_KEYS = [
  'English exercise names',
  'Show the English name in parentheses next to the translated one. Each language remembers its own choice.',
]

describe('exercise-name toggle locale coverage', () => {
  const packs = import.meta.glob('../locales/*.js', { eager: true, import: 'default' })
  const localeCodes = Object.keys(LANGS).filter(code => code !== 'en' && !DERIVED_LOCALES[code])

  it('defines both Settings labels in every current locale pack', () => {
    expect(Object.keys(packs)).toHaveLength(localeCodes.length)
    for (const code of localeCodes) {
      const pack = packs[`../locales/${code}.js`]
      expect(pack, `${code} locale pack is missing`).toBeTruthy()
      for (const key of PACK_KEYS) {
        expect(Object.hasOwn(pack, key), `${code} is missing ${key}`).toBe(true)
        expect(pack[key], `${code} has a blank ${key}`).toEqual(expect.any(String))
        expect(pack[key].trim(), `${code} has a blank ${key}`).not.toBe('')
      }
    }
  })
})