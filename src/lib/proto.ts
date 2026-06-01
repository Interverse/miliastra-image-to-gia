import protobuf from 'protobufjs'

let cached: Promise<{ root: protobuf.Root; AssetBundle: protobuf.Type; ResourceEntry: protobuf.Type; ResourceLocator: protobuf.Type }> | null = null

export async function loadGiaTypes(assetBase: string) {
  if (!cached) {
    cached = (async () => {
      const protoUrl = new URL('gia_with_ui_rotation_v6.proto', assetBase).toString()
      const protoText = await fetch(protoUrl).then((r) => {
        if (!r.ok) throw new Error(`Failed to load proto: ${r.status}`)
        return r.text()
      })
      const parsed = protobuf.parse(protoText, { keepCase: true })
      const root = parsed.root
      const AssetBundle = root.lookupType('AssetBundle')
      const ResourceEntry = root.lookupType('ResourceEntry')
      const ResourceLocator = root.lookupType('ResourceLocator')
      return { root, AssetBundle, ResourceEntry, ResourceLocator }
    })()
  }
  return cached
}
