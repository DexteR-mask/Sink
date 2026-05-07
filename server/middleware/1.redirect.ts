import type { Link } from '@/types'
import { withQuery } from 'ufo'

const SOCIAL_BOTS = [
  'applebot',
  'discordbot',
  'facebot',
  'facebookexternalhit',
  'linkedinbot',
  'linkexpanding',
  'mastodon',
  'skypeuripreview',
  'slackbot',
  'slackbot-linkexpanding',
  'snapchat',
  'telegrambot',
  'tiktok',
  'twitterbot',
  'whatsapp',
]

const APPLE_DEVICE_UA_MARKERS = ['iphone', 'ipad', 'ipod', 'crios']
const PATH_TRIM_REGEX = /^\/|\/$/g

function isSocialBot(userAgent: string): boolean {
  const ua = userAgent.toLowerCase()
  return SOCIAL_BOTS.some(bot => ua.includes(bot))
}

function getDeviceRedirectUrl(userAgent: string, link: Link): string | null {
  if (!link.apple && !link.google)
    return null

  const ua = userAgent.toLowerCase()

  if (link.google && ua.includes('android')) {
    return link.google
  }

  if (link.apple && APPLE_DEVICE_UA_MARKERS.some(marker => ua.includes(marker))) {
    return link.apple
  }

  return null
}

function hasOgConfig(link: Link): boolean {
  return !!(link.title || link.image)
}

export default eventHandler(async (event) => {
  // console.log('[redirect] incoming request:', { path: event.path, method: event.method })

  // Skip API routes, static assets, and other non-redirect paths
  if (event.path.startsWith('/api/') || event.path.startsWith('/_')) {
    return
  }

  const rawPath = event.path.replace(PATH_TRIM_REGEX, '')
  const [slug, accessId, ...pathRest] = rawPath.split('/')
  console.log('[redirect] parsed path:', { slug, accessId, pathRest, rawPath })
  const { slugRegex, reserveSlug } = useAppConfig()
  const { homeURL, linkCacheTtl, caseSensitive, redirectWithQuery, redirectStatusCode } = useRuntimeConfig(event)
  const { cloudflare } = event.context

  if (event.path === '/' && homeURL) {
  //  setHeader(event, 'Cache-Control', 'no-cache, no-store, must-revalidate')
    return sendRedirect(event, homeURL)
  }

  const { notFoundRedirect } = useRuntimeConfig(event)
  // Bypass redirect check for notFoundRedirect path to prevent infinite loop
  if (notFoundRedirect && event.path === notFoundRedirect) {
    return
  }

  if (slug && !reserveSlug.includes(slug) && pathRest.length === 0 && slugRegex.test(slug) && cloudflare) {
    // console.log('[redirect] processing link slug:', { slug, caseSensitive })
    let link: Link | null = null

    const lowerCaseSlug = slug.toLowerCase()
    link = await getLink(event, caseSensitive ? slug : lowerCaseSlug, linkCacheTtl)
    // console.log('[redirect] fetched link from KV:', { slug: caseSensitive ? slug : lowerCaseSlug, found: !!link })

    if (!caseSensitive && !link && lowerCaseSlug !== slug) {
    //  console.log('original slug fallback:', `slug:${slug} lowerCaseSlug:${lowerCaseSlug}`)
      link = await getLink(event, slug, linkCacheTtl)
    }

    if (link) {
      let locale: RedirectLocale | undefined
      const getLocale = () => {
        locale ??= resolveRedirectLocale(event)
        return locale
      }
      const sendNoStoreHtml = (html: string) => {
        setHeader(event, 'Content-Type', 'text/html; charset=utf-8')
        setHeader(event, 'Cache-Control', 'no-store')
        return html
      }

      // Password protection check
      if (link.password) {
        // console.log('[redirect] link has password protection')
        const headerPassword = getHeader(event, 'x-link-password')

        if (event.method === 'POST') {
          const body = await readBody(event)
          const submittedPassword = body?.password

          if (submittedPassword !== link.password) {
            return sendNoStoreHtml(generatePasswordHtml(slug, { hasError: true, locale: getLocale() }))
          }

          // Password correct - show unsafe warning if needed
          if (link.unsafe && body?.confirm !== 'true') {
            return sendNoStoreHtml(generateUnsafeWarningHtml(slug, link.url, { password: link.password, locale: getLocale() }))
          }
        }
        else if (headerPassword) {
          if (headerPassword !== link.password) {
            throw createError({ status: 403, statusText: 'Incorrect password' })
          }
          // Header-password path: check unsafe warning via x-link-confirm header
          if (link.unsafe && getHeader(event, 'x-link-confirm') !== 'true') {
            throw createError({ status: 403, statusText: 'Unsafe link: confirmation required (set x-link-confirm: true header)' })
          }
        }
        else {
          return sendNoStoreHtml(generatePasswordHtml(slug, { locale: getLocale() }))
        }
      }

      // Unsafe link warning (for links without password)
      if (!link.password && link.unsafe) {
        // console.log('[redirect] link is unsafe, showing warning')
        if (event.method === 'POST') {
          const body = await readBody(event)
          if (body?.confirm !== 'true') {
            return sendNoStoreHtml(generateUnsafeWarningHtml(slug, link.url, { locale: getLocale() }))
          }
        }
        else {
          return sendNoStoreHtml(generateUnsafeWarningHtml(slug, link.url, { locale: getLocale() }))
        }
      }

      if (accessId) {
        try {
          event.context.accessId = accessId
        }
        catch (error) {
          console.error('Failed saving access id:', error)
        }
      }
      console.log('[redirect] finalizing redirect, writing access log and preparing response')
      event.context.link = link
      try {
        await useAccessLog(event)
      }
      catch (error) {
        console.error('Failed write access log:', error)
      }

      const userAgent = getHeader(event, 'user-agent') || ''
      const query = getQuery(event)
      const shouldRedirectWithQuery = link.redirectWithQuery ?? redirectWithQuery
      const buildTarget = (url: string) => shouldRedirectWithQuery ? withQuery(url, query) : url
      // console.log('[redirect] preparing redirect:', { targetUrl: link.url, hasQuery: Object.keys(query).length > 0, userAgent: userAgent.substring(0, 50) })

      const deviceRedirectUrl = getDeviceRedirectUrl(userAgent, link)
      if (deviceRedirectUrl) {
      //  console.log('[redirect] device-specific redirect:', { deviceRedirectUrl })
        return sendRedirect(event, deviceRedirectUrl, +redirectStatusCode)
      }

      if (isSocialBot(userAgent) && hasOgConfig(link)) {
        // console.log('[redirect] social bot detected, returning OG HTML')
        const baseUrl = `${getRequestProtocol(event)}://${getRequestHost(event)}`
        const html = generateOgHtml(link, buildTarget(link.url), baseUrl)
        setHeader(event, 'Content-Type', 'text/html; charset=utf-8')
        return html
      }

      if (link.cloaking) {
        // console.log('[redirect] cloaking enabled, returning cloaking HTML')
        const baseUrl = `${getRequestProtocol(event)}://${getRequestHost(event)}`
        const html = generateCloakingHtml(link, buildTarget(link.url), baseUrl)
        setHeader(event, 'Content-Type', 'text/html; charset=utf-8')
        setHeader(event, 'Cache-Control', 'no-store, private')
        return html
      }

      return sendRedirect(event, buildTarget(link.url), +redirectStatusCode)
    }
    else {
      // console.log('[redirect] link not found for slug:', { slug, caseSensitive })
      if (notFoundRedirect) {
        return sendRedirect(event, notFoundRedirect, 302)
      }

      throw createError({ status: 404, statusText: 'Link not found' })
    }
  }
})
