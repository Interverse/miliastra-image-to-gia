// Regression tests against the supplied Client Control Template reference.
//
// `public/client-template.gia` is the file the user provided verbatim. It is
// both the structural template the exporter generates from and the permanent
// fixture these tests read, so the two can never drift apart.

import { describe, expect, it } from 'vitest'
import {
  CLIENT_CONTAINER_RESOURCE_CLASS,
  IMAGE_RESOURCE_IDS,
  UI_CONTROL_RESOURCE_CLASS,
  bytesToPayload,
} from '../src/lib/giaCommon'
import {
  CLIENT_TEMPLATE_CONTAINER_NAME,
  parseClientTemplate,
  serializeClientGia,
} from '../src/lib/giaClient'
import { inspectGia, validateClientGia } from '../src/lib/giaInspect'
import type { ImagePlan, PlannedShape } from '../src/lib/imagePlan'
import * as pb from '../src/lib/pbraw'
import { blobBytes, clientTemplateBytes } from './helpers'

const CIRCLE_X_OFFSET = 100

function reference() {
  return inspectGia(clientTemplateBytes())
}

function childNamed(name: string) {
  const found = reference().children.find((child) => child.name === name)
  if (!found) throw new Error(`reference has no child named ${name}`)
  return found
}

describe('lossless protobuf codec', () => {
  it('round-trips the client reference byte for byte', () => {
    const payload = bytesToPayload(clientTemplateBytes())
    const message = pb.parseMessage(payload)

    // Force a deep parse of every length-delimited field that is a message, so
    // the re-encode really exercises the codec instead of replaying raw bytes.
    const deepParse = (node: pb.PbMessage, depth: number) => {
      if (depth > 12) return
      for (const field of [...node.fields]) {
        if (field.wire !== pb.WIRE_LENGTH || !field.bytes?.length) continue
        let parsed: pb.PbMessage
        try {
          parsed = pb.parseMessage(field.bytes)
        } catch {
          continue
        }
        if (parsed.fields.length === 0) continue
        // Only descend where re-encoding reproduces the original bytes; that
        // is exactly the test for "this really was a nested message".
        const roundTrip = pb.serializeMessage({ fields: parsed.fields })
        if (roundTrip.length !== field.bytes.length) continue
        if (!roundTrip.every((byte, i) => byte === field.bytes![i])) continue
        deepParse(pb.asMessage(field), depth + 1)
      }
    }
    deepParse(message, 0)

    // Drop every cached buffer so serialization has to rebuild from fields.
    const clearCaches = (node: pb.PbMessage) => {
      node.cache = undefined
      for (const field of node.fields) if (field.msg) clearCaches(field.msg)
    }
    clearCaches(message)

    const encoded = pb.serializeMessage(message)
    expect(Buffer.from(encoded).toString('hex')).toBe(Buffer.from(payload).toString('hex'))
  })
})

describe('client reference structure', () => {
  it('is a Client Control Template container with two image children', () => {
    const inspected = reference()
    expect(inspected.target).toBe('client')
    expect(inspected.container.resourceClass).toBe(CLIENT_CONTAINER_RESOURCE_CLASS)
    expect(inspected.container.name).toBe(CLIENT_TEMPLATE_CONTAINER_NAME)
    expect(inspected.children.map((child) => child.name).sort()).toEqual(['Circle', 'Square'])
    for (const child of inspected.children) {
      expect(child.resourceClass).toBe(UI_CONTROL_RESOURCE_CLASS)
      expect(child.parentGuid).toBe(inspected.container.guid)
    }
    expect(inspected.container.childGuids.sort()).toEqual(
      inspected.children.map((child) => child.guid).sort(),
    )
    expect(inspected.container.referenceGuids.sort()).toEqual(
      inspected.children.map((child) => child.guid).sort(),
    )
  })

  it('uses the shared image resource IDs', () => {
    expect(childNamed('Square').imageId).toBe(IMAGE_RESOURCE_IDS.square)
    expect(childNamed('Circle').imageId).toBe(IMAGE_RESOURCE_IDS.circle)
    expect(childNamed('Square').shape).toBe('square')
    expect(childNamed('Circle').shape).toBe('circle')
  })

  it('encodes the +100 X offset as the circle transform local position', () => {
    const square = childNamed('Square')
    const circle = childNamed('Circle')
    expect(square.transforms).toHaveLength(4)
    expect(circle.transforms).toHaveLength(4)

    for (let i = 0; i < 4; i += 1) {
      // Same transform repeated once per device profile.
      expect(square.transforms[i].x).toBeCloseTo(0, 3)
      expect(square.transforms[i].y).toBeCloseTo(0, 3)
      expect(circle.transforms[i].y).toBeCloseTo(0, 3)
      expect(circle.transforms[i].x - square.transforms[i].x).toBeCloseTo(CIRCLE_X_OFFSET, 2)
      // Both are 80x80 in the reference, so the offset is a position, not a
      // size or a pivot difference.
      expect(square.transforms[i].width).toBeCloseTo(80, 3)
      expect(circle.transforms[i].width).toBeCloseTo(80, 3)
    }
  })

  it('has no server-only records and passes client validation', () => {
    const inspected = reference()
    for (const child of inspected.children) {
      expect(child.properties).toContain('73/96')
      expect(child.properties).not.toContain('21/38')
      expect(child.properties).not.toContain('4/23')
    }
    expect(inspected.container.properties).not.toContain('38/56')
    // The reference itself is only invalid on the placeholder name, which is
    // exactly what generation has to replace.
    expect(validateClientGia(inspected)).toEqual([
      `container is still named the template placeholder "${CLIENT_TEMPLATE_CONTAINER_NAME}"`,
    ])
  })

  it('has Square and Circle records that differ only in per-object values', () => {
    const template = parseClientTemplate(clientTemplateBytes())
    const square = template.childrenByName.get('Square')!
    const circle = template.childrenByName.get('Circle')!

    // If the two records differ structurally, one prototype would not be
    // enough to emit both primitives.
    const shapeOf = (record: pb.PbMessage): string => {
      const describe = (node: pb.PbMessage, depth: number): string =>
        node.fields
          .map((field) => {
            if (field.wire !== pb.WIRE_LENGTH) return `${field.no}:${field.wire}`
            if (depth > 8) return `${field.no}:2`
            let parsed: pb.PbMessage
            try {
              parsed = pb.parseMessage(field.bytes ?? new Uint8Array(0))
            } catch {
              return `${field.no}:2`
            }
            if (!parsed.fields.length) return `${field.no}:2`
            const encoded = pb.serializeMessage({ fields: parsed.fields })
            const original = field.bytes ?? new Uint8Array(0)
            if (encoded.length !== original.length || !encoded.every((b, i) => b === original[i])) {
              return `${field.no}:2`
            }
            return `${field.no}:2{${describe(pb.asMessage(field), depth + 1)}}`
          })
          .join(',')
      return describe(record, 0)
    }

    // The only structural difference is the transform's position sub-message:
    // Square writes it empty (0, 0) while Circle carries an explicit X. That
    // is the +100 offset, and nothing else about the two records differs, so
    // one prototype can emit either primitive.
    const squareShape = shapeOf(square)
    const circleShape = shapeOf(circle)
    expect(circleShape).not.toBe(squareShape)
    expect(circleShape.split('504:2{501:5}').length - 1).toBe(4)
    expect(circleShape.split('504:2{501:5}').join('504:2')).toBe(squareShape)
  })
})

// A plan is the logical image representation both exporters consume, so a
// hand-built one reproduces the reference layout exactly.
function referenceShapedPlan(containerName: string): ImagePlan {
  const rootGuid = 1073742130
  const shapes: Omit<PlannedShape, 'index' | 'guid' | 'uiId' | 'label'>[] = [
    {
      shape: 'circle',
      imageId: IMAGE_RESOURCE_IDS.circle,
      colorArgb: 0xffffffff,
      x: CIRCLE_X_OFFSET,
      y: 0,
      width: 80,
      height: 80,
      rotationDegrees: 0,
    },
    {
      shape: 'square',
      imageId: IMAGE_RESOURCE_IDS.square,
      colorArgb: 0xffffffff,
      x: 0,
      y: 0,
      width: 80,
      height: 80,
      rotationDegrees: 0,
    },
  ]
  return {
    container: {
      guid: rootGuid,
      uiId: 1,
      name: containerName,
      x: 0,
      y: 0,
      width: 150,
      height: 150,
      applyTransform: true,
    },
    count: shapes.length,
    deviceScales: { desktop: 1, mobile: 1, controller: 1, mobileController: 1 },
    sourceWidth: 2,
    sourceHeight: 1,
    // A Client hierarchy renders its first child first; the two shapes below
    // do not overlap, so they are listed in the reference's own order.
    compositing: 'first-behind',
    guidAt: (index) => rootGuid + 1 + index,
    nextFreeGuid: () => rootGuid + 1 + shapes.length,
    shapeAt: (index, out) => {
      Object.assign(out, shapes[index], {
        index,
        guid: rootGuid + 1 + index,
        uiId: 2 + index,
        label: `${containerName} ${index + 1}`,
      })
      return out
    },
  }
}

describe('generated client image vs the reference', () => {
  it('reproduces the reference structure with a renamed container', async () => {
    const blob = serializeClientGia(referenceShapedPlan('Mario'), clientTemplateBytes(), 'Mario.gia')
    const generated = inspectGia(await blobBytes(blob))
    const original = reference()

    expect(validateClientGia(generated)).toEqual([])
    expect(generated.target).toBe('client')
    expect(generated.container.resourceClass).toBe(original.container.resourceClass)
    expect(generated.engineVersion).toBe(original.engineVersion)

    // The placeholder name is gone, replaced by the generated image name.
    expect(generated.container.name).toBe('Mario')
    expect(generated.container.name).not.toBe(CLIENT_TEMPLATE_CONTAINER_NAME)

    expect(generated.children).toHaveLength(2)
    expect(generated.children.map((child) => child.resourceClass)).toEqual(
      original.children.map((child) => child.resourceClass),
    )
    // Reference dependency order is [Circle, Square]; the plan matches it.
    expect(generated.children.map((child) => child.imageId)).toEqual(
      original.children.map((child) => child.imageId),
    )
    expect(generated.children.map((child) => child.colorArgb)).toEqual(
      original.children.map((child) => child.colorArgb),
    )
    expect(generated.children.map((child) => child.properties)).toEqual(
      original.children.map((child) => child.properties),
    )
    expect(generated.container.properties).toEqual(original.container.properties)
    expect(generated.container.descriptors).toEqual(original.container.descriptors)

    for (let i = 0; i < 2; i += 1) {
      for (let t = 0; t < 4; t += 1) {
        const left = generated.children[i].transforms[t]
        const right = original.children[i].transforms[t]
        expect(left.x).toBeCloseTo(right.x, 2)
        expect(left.y).toBeCloseTo(right.y, 2)
        expect(left.width).toBeCloseTo(right.width, 2)
        expect(left.height).toBeCloseTo(right.height, 2)
      }
    }

    // The known anchor survives regeneration.
    const circle = generated.children.find((child) => child.shape === 'circle')!
    const square = generated.children.find((child) => child.shape === 'square')!
    expect(circle.transforms[0].x - square.transforms[0].x).toBeCloseTo(CIRCLE_X_OFFSET, 3)

    // References stay internally consistent after renumbering.
    expect(generated.container.childGuids).toEqual(generated.children.map((child) => child.guid))
    expect(generated.container.referenceGuids).toEqual(generated.children.map((child) => child.guid))
    for (const child of generated.children) expect(child.parentGuid).toBe(generated.container.guid)
    expect(new Set(generated.children.map((child) => child.uiId)).size).toBe(2)
  })

  it('refuses to emit the placeholder container name', () => {
    expect(() => serializeClientGia(referenceShapedPlan(CLIENT_TEMPLATE_CONTAINER_NAME), clientTemplateBytes())).toThrow(
      /placeholder/i,
    )
  })

})
