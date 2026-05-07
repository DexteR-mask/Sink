export default defineAppConfig({
  title: 'Sink',
  github: '',
  coffee: '',
  twitter: '',
  telegram: '',
  description: '',
  image: '',
  previewTTL: 300, // 5 minutes
  slugRegex: /^[a-z0-9]+(?:-[a-z0-9]+)*$/i,
  reserveSlug: [
    'dashboard',
  ],
})
