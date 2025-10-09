/// <reference types="svelte" />

declare module '*.png' {
  const src: string
  export default src
}

declare module '*.ico' {
  const src: string
  export default src
}

declare module '*.ico?url' {
  const src: string
  export default src
}
