import Foundation
import Vision
import CoreImage
import ImageIO

// Zero-dependency local Vision & EXIF telemetry engine
// Utilizes Apple Neural Engine (Vision.framework) and ImageIO

let args = Array(CommandLine.arguments.dropFirst())

guard let targetPath = args.first, !targetPath.hasPrefix("--") else {
    print("""
    ===============================================================
    📸 Local Vision & EXIF Telemetry Engine
    ===============================================================
    Usage:
      swift .sos/lib/vision.swift <path-to-image-or-directory> [options]

    Options:
      --ocr                  Run optical character recognition
      --json                 Print JSON output to stdout
      --output <file.md>     Explicit output path for Tier 2 Markdown manifest
      --output-json <file>   Explicit output path for machine JSON telemetry
      --id <node-id>         Node ID for YAML frontmatter (default: auto)
      --parent <parent-id>   Parent Node ID for YAML frontmatter (default: auto)
      --domain <domain>      Discovered domain name (required for sources outside the repository)
      --force / --overwrite  Overwrite existing manifest/telemetry if collision detected

    Features:
      • Automatic non-destructive collision prevention (auto-incrementing slugs)
      • Dynamic domain and charter discovery from directory tree
      • Camera EXIF/TIFF/GPS Metadata & Apple Maps navigation links
      • Apple Neural Scene & Atmosphere Classification (VNClassifyImageRequest)
      • Luminance & Color Warmth Analysis (CoreImage Area Average)
      • High-Accuracy Optical Character Recognition with tag-safe escaping (\\#)
    ===============================================================
    """)
    exit(0)
}

func getArgValue(_ flag: String) -> String? {
    if let idx = args.firstIndex(of: flag), idx + 1 < args.count {
        return args[idx + 1]
    }
    return nil
}

let doOCR = args.contains("--ocr")
let doJSON = args.contains("--json")
let isForce = args.contains("--force") || args.contains("--overwrite")

let fileManager = FileManager.default
let workingDirectory = fileManager.currentDirectoryPath
let targetURL = URL(fileURLWithPath: targetPath, relativeTo: URL(fileURLWithPath: workingDirectory, isDirectory: true)).standardizedFileURL
let absTarget = targetURL.path
var isDir: ObjCBool = false

guard fileManager.fileExists(atPath: absTarget, isDirectory: &isDir) else {
    print("Error: Target path does not exist: \(absTarget)")
    exit(1)
}

// 1. Dynamic repository and domain discovery (zero instance hardcoding)
struct DomainConfig {
    let name: String
    let path: String
    let prefix: String
    let parent: String
    let exposure: String
}

func frontmatterValue(_ key: String, in content: String) -> String? {
    for rawLine in content.components(separatedBy: .newlines) {
        let line = rawLine.trimmingCharacters(in: .whitespaces)
        guard line.hasPrefix("\(key):") else { continue }
        let value = String(line.dropFirst(key.count + 1)).trimmingCharacters(in: .whitespaces)
        return value.trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
    }
    return nil
}

func findRepositoryRoot(from start: String) -> String? {
    var current = URL(fileURLWithPath: start, isDirectory: true).standardizedFileURL
    while true {
        let marker = current.appendingPathComponent(".sos/lib/domains.mjs").path
        if fileManager.fileExists(atPath: marker) { return current.path }
        let parent = current.deletingLastPathComponent()
        if parent.path == current.path { return nil }
        current = parent
    }
}

guard let repositoryRoot = findRepositoryRoot(from: workingDirectory) else {
    print("Error: No Sovereign OS repository found at or above \(workingDirectory)")
    exit(1)
}

var discoveredDomains: [DomainConfig] = []
for name in (try? fileManager.contentsOfDirectory(atPath: repositoryRoot)) ?? [] {
    if name.hasPrefix(".") { continue }
    let domainPath = URL(fileURLWithPath: repositoryRoot).appendingPathComponent(name).path
    let charterPath = URL(fileURLWithPath: domainPath).appendingPathComponent("SPACE.md").path
    guard let content = try? String(contentsOfFile: charterPath, encoding: .utf8),
          let parent = frontmatterValue("id", in: content) else { continue }
    let prefix = parent.split(separator: ":", maxSplits: 1).first.map(String.init) ?? String(name.prefix(4))
    let exposure = frontmatterValue("exposure", in: content) ?? "public"
    discoveredDomains.append(DomainConfig(name: name, path: domainPath, prefix: prefix, parent: parent, exposure: exposure))
}

let requestedDomain = getArgValue("--domain")
let activeDomain = requestedDomain.flatMap { requested in
    discoveredDomains.first { $0.name == requested }
} ?? discoveredDomains.first { domain in
    absTarget == domain.path || absTarget.hasPrefix(domain.path + "/")
}

guard let domainConfig = activeDomain else {
    print("Error: Cannot resolve a domain for \(absTarget). Pass --domain <name>.")
    exit(1)
}

let detectedDomain = domainConfig.name
let detectedPrefix = domainConfig.prefix
let detectedParent = domainConfig.parent

// Derive a clean base slug from the folder / file name
var folderName = (absTarget as NSString).lastPathComponent
var cur = absTarget
while cur.contains("/archive/") || cur.contains("/inbox/") {
    let parent = (cur as NSString).deletingLastPathComponent
    let parentName = (parent as NSString).lastPathComponent
    if parentName == "archive" || parentName == "inbox" {
        folderName = (cur as NSString).lastPathComponent
        break
    }
    cur = parent
}

let baseSlug = folderName.lowercased()
    .replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
    .trimmingCharacters(in: CharacterSet(charactersIn: "-"))

var slug = baseSlug.isEmpty ? "visual-batch" : baseSlug

// Default Output Paths
let customDomain = detectedDomain
let customParent = getArgValue("--parent") ?? detectedParent

var resolvedMDPath = getArgValue("--output")
var resolvedJSONPath = getArgValue("--output-json")

if resolvedMDPath == nil && resolvedJSONPath == nil && !doJSON {
    let candidateMD = "\(domainConfig.path)/assets/asset-\(slug)-photographic-telemetry.md"
    
    // Collision detection on default path
    if fileManager.fileExists(atPath: candidateMD) && !isForce {
        var counter = 2
        while fileManager.fileExists(atPath: "\(domainConfig.path)/assets/asset-\(slug)-\(counter)-photographic-telemetry.md") {
            counter += 1
        }
        slug = "\(slug)-\(counter)"
        print("⚠️ [COLLISION PREVENTION] Existing asset manifest detected. Allocating safe slug: asset-\(slug)-photographic-telemetry.md")
    }
    resolvedMDPath = "\(domainConfig.path)/assets/asset-\(slug)-photographic-telemetry.md"
}

if resolvedJSONPath == nil && resolvedMDPath != nil {
    // Default JSON location in cold archive (directly under inbox/archive/)
    resolvedJSONPath = "\(domainConfig.path)/inbox/archive/\(slug)-vision-telemetry.json"
}

let customId = getArgValue("--id") ?? "\(detectedPrefix):asset-\(slug)-photographic-telemetry"

var imagePaths: [String] = []
if isDir.boolValue {
    guard let enumerator = fileManager.enumerator(atPath: absTarget) else {
        print("Failed to read directory: \(absTarget)")
        exit(1)
    }
    while let el = enumerator.nextObject() as? String {
        let ext = (el as NSString).pathExtension.lowercased()
        if ["jpg", "jpeg", "png", "heic", "tiff", "webp", "dng", "avif"].contains(ext) {
            imagePaths.append("\(absTarget)/\(el)")
        }
    }
} else {
    imagePaths.append(absTarget)
}

imagePaths.sort()
print("Analyzing \(imagePaths.count) visual asset(s)...")

struct ExifData: Codable {
    let make: String?
    let model: String?
    let lens: String?
    let focalLength: String?
    let fNumber: String?
    let iso: String?
    let shutterSpeed: String?
    let dateTimeOriginal: String?
    let latitude: Double?
    let longitude: Double?
}

struct AssetVisionTelemetry: Codable {
    let filename: String
    let relativePath: String
    let width: Int
    let height: Int
    let aspectRatio: String
    let averageLuminance: Float
    let colorWarmth: String
    let lightingCategory: String
    let exif: ExifData?
    let neuralTags: [String]
    let ocrText: [String]?
}

let ciContext = CIContext(options: nil)
var allResults: [AssetVisionTelemetry] = []

var aspectCounts: [String: Int] = [:]
var lightingCounts: [String: Int] = [:]
var allTagsCount: [String: Int] = [:]

for (idx, imgPath) in imagePaths.enumerated() {
    let url = URL(fileURLWithPath: imgPath)
    guard let ciImage = CIImage(contentsOf: url) else { continue }
    
    let extent = ciImage.extent
    let width = Int(extent.width)
    let height = Int(extent.height)
    let ratio = height > 0 ? Float(width) / Float(height) : 1.0
    
    var aspectStr = "Other"
    if abs(ratio - 1.0) < 0.05 {
        aspectStr = "1:1 Square"
    } else if ratio < 0.95 {
        if abs(ratio - 0.8) < 0.08 { aspectStr = "4:5 Portrait" }
        else { aspectStr = "Vertical Portrait" }
    } else {
        aspectStr = "Horizontal Landscape"
    }
    aspectCounts[aspectStr, default: 0] += 1
    
    // 1. EXIF / ImageIO Extraction
    var exifMake: String? = nil
    var exifModel: String? = nil
    var exifLens: String? = nil
    var exifFocal: String? = nil
    var exifFNum: String? = nil
    var exifISO: String? = nil
    var exifShutter: String? = nil
    var exifDate: String? = nil
    var exifLat: Double? = nil
    var exifLon: Double? = nil
    var hasExif = false
    
    if let imageSource = CGImageSourceCreateWithURL(url as CFURL, nil),
       let properties = CGImageSourceCopyPropertiesAtIndex(imageSource, 0, nil) as? [CFString: Any] {
        
        if let tiff = properties[kCGImagePropertyTIFFDictionary] as? [CFString: Any] {
            exifMake = tiff[kCGImagePropertyTIFFMake] as? String
            exifModel = tiff[kCGImagePropertyTIFFModel] as? String
            exifDate = tiff[kCGImagePropertyTIFFDateTime] as? String
            if exifMake != nil || exifModel != nil { hasExif = true }
        }
        
        if let exif = properties[kCGImagePropertyExifDictionary] as? [CFString: Any] {
            hasExif = true
            if let lens = exif[kCGImagePropertyExifLensModel] as? String { exifLens = lens }
            if let f = exif[kCGImagePropertyExifFNumber] as? Double { exifFNum = "f/\(f)" }
            if let focal = exif[kCGImagePropertyExifFocalLength] as? Double { exifFocal = "\(focal)mm" }
            if let isoArray = exif[kCGImagePropertyExifISOSpeedRatings] as? [Int], let firstIso = isoArray.first {
                exifISO = "ISO \(firstIso)"
            }
            if let exp = exif[kCGImagePropertyExifExposureTime] as? Double {
                if exp < 1.0 && exp > 0 {
                    exifShutter = "1/\(Int(round(1.0 / exp)))s"
                } else {
                    exifShutter = "\(exp)s"
                }
            }
            if let dt = exif[kCGImagePropertyExifDateTimeOriginal] as? String { exifDate = dt }
        }
        
        if let gps = properties[kCGImagePropertyGPSDictionary] as? [CFString: Any] {
            if let lat = gps[kCGImagePropertyGPSLatitude] as? Double,
               let lon = gps[kCGImagePropertyGPSLongitude] as? Double {
                exifLat = lat
                exifLon = lon
                hasExif = true
            }
        }
    }
    
    let parsedExif: ExifData? = hasExif ? ExifData(
        make: exifMake,
        model: exifModel,
        lens: exifLens,
        focalLength: exifFocal,
        fNumber: exifFNum,
        iso: exifISO,
        shutterSpeed: exifShutter,
        dateTimeOriginal: exifDate,
        latitude: exifLat,
        longitude: exifLon
    ) : nil
    
    // 2. Luminance & Color Warmth
    var avgLum: Float = 0.5
    var warmthStr = "Muted / Desaturated Neutral"
    
    let filter = CIFilter(name: "CIAreaAverage")
    filter?.setValue(ciImage, forKey: kCIInputImageKey)
    filter?.setValue(CIVector(cgRect: extent), forKey: kCIInputExtentKey)
    
    if let outputImage = filter?.outputImage {
        var bitmap = [UInt8](repeating: 0, count: 4)
        ciContext.render(outputImage, toBitmap: &bitmap, rowBytes: 4, bounds: CGRect(x: 0, y: 0, width: 1, height: 1), format: .RGBA8, colorSpace: nil)
        let r = Float(bitmap[0]) / 255.0
        let g = Float(bitmap[1]) / 255.0
        let b = Float(bitmap[2]) / 255.0
        avgLum = (0.299 * r + 0.587 * g + 0.114 * b)
        
        if r > b * 1.15 { warmthStr = "Warm (Amber / Golden)" }
        else if b > r * 1.15 { warmthStr = "Cool (Twilight / Blue)" }
    }
    
    // 3. Apple Vision Neural Classification
    let requestHandler = VNImageRequestHandler(ciImage: ciImage, options: [:])
    let classifyReq = VNClassifyImageRequest()
    var neuralTags: [String] = []
    
    var requestsToRun: [VNRequest] = [classifyReq]
    var ocrReq: VNRecognizeTextRequest? = nil
    if doOCR {
        let req = VNRecognizeTextRequest()
        req.recognitionLevel = .accurate
        ocrReq = req
        requestsToRun.append(req)
    }
    
    do {
        try requestHandler.perform(requestsToRun)
        if let classifyResults = classifyReq.results {
            let highConf = classifyResults.filter { $0.confidence > 0.40 }.prefix(6)
            for res in highConf {
                neuralTags.append(res.identifier)
                allTagsCount[res.identifier, default: 0] += 1
            }
        }
    } catch {}
    
    // 4. OCR
    var recognizedStrings: [String]? = nil
    if let ocrResults = ocrReq?.results, !ocrResults.isEmpty {
        let strings = ocrResults.compactMap { $0.topCandidates(1).first?.string }
        if !strings.isEmpty { recognizedStrings = strings }
    }
    
    // Multi-Signal Lighting Categorization
    var lighting = "Indoor Ambient / Even Light"
    let tagsSet = Set(neuralTags)
    
    if tagsSet.contains("night_sky") || (tagsSet.contains("night") && avgLum < 0.20) {
        lighting = "Night / Evening Sky"
    } else if tagsSet.contains("sunset_sunrise") || tagsSet.contains("sunset") || tagsSet.contains("sunrise") {
        lighting = "Golden Hour / Sunset"
    } else if tagsSet.contains("blue_sky") || (tagsSet.contains("outdoor") && avgLum >= 0.20 && !tagsSet.contains("cloudy")) {
        lighting = "Direct Daylight / Clear Sky"
    } else if tagsSet.contains("cloudy") || (tagsSet.contains("sky") && !tagsSet.contains("blue_sky") && !tagsSet.contains("night_sky")) {
        lighting = "Overcast / Diffused Daylight"
    } else if tagsSet.contains("outdoor") && avgLum < 0.20 {
        lighting = "Outdoor Twilight / Deep Shadow"
    } else if avgLum < 0.15 {
        lighting = "Indoor Low-Key / Dim Practical"
    } else {
        lighting = "Indoor Ambient / Even Light"
    }
    lightingCounts[lighting, default: 0] += 1
    
    let filename = (imgPath as NSString).lastPathComponent
    let relPath = isDir.boolValue ? (imgPath.replacingOccurrences(of: absTarget + "/", with: "")) : filename
    
    let itemTelemetry = AssetVisionTelemetry(
        filename: filename,
        relativePath: relPath,
        width: width,
        height: height,
        aspectRatio: aspectStr,
        averageLuminance: avgLum,
        colorWarmth: warmthStr,
        lightingCategory: lighting,
        exif: parsedExif,
        neuralTags: neuralTags,
        ocrText: recognizedStrings
    )
    allResults.append(itemTelemetry)
    
    if (idx + 1) % 100 == 0 || idx == imagePaths.count - 1 {
        print("Processed \(idx + 1)/\(imagePaths.count) assets...")
    }
}

// 1. Output JSON File if requested or auto-resolved
if let outJsonPath = resolvedJSONPath {
    let jsonDir = (outJsonPath as NSString).deletingLastPathComponent
    try? fileManager.createDirectory(atPath: jsonDir, withIntermediateDirectories: true, attributes: nil)
    
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    if let data = try? encoder.encode(allResults) {
        try? data.write(to: URL(fileURLWithPath: outJsonPath))
        print("📊 Generated Machine JSON (Tier 3): \(outJsonPath)")
    }
}

// 2. Output Markdown Manifest if requested or auto-resolved
if let outMDPath = resolvedMDPath {
    let mdDir = (outMDPath as NSString).deletingLastPathComponent
    try? fileManager.createDirectory(atPath: mdDir, withIntermediateDirectories: true, attributes: nil)
    
    let totalCount = allResults.count
    let dateFormatter = DateFormatter()
    dateFormatter.locale = Locale(identifier: "en_US_POSIX")
    dateFormatter.dateFormat = "yyyy-MM-dd"
    let dateStr = dateFormatter.string(from: Date())
    
    var jsonLink = "N/A"
    if let outJsonPath = resolvedJSONPath {
        let jsonName = (outJsonPath as NSString).lastPathComponent
        jsonLink = "[\(jsonName)](../inbox/archive/\(jsonName))"
    }
    
    var md = """
    ---
    id: "\(customId)"
    parent: "\(customParent)"
    related: []
    title: "Asset Telemetry: Verbatim Computer Vision & Photographic Extraction Ledger (\(slug.capitalized))"
    description: "Tier 2 machine extraction ledger: Apple Vision (VNClassifyImageRequest, VNRecognizeTextRequest) and CoreImage telemetry across \(totalCount) archival visual assets."
    type: "asset-manifest"
    domain: "\(customDomain)"
    exposure: "\(domainConfig.exposure)"
    status: "active"
    created: \(dateStr)
    updated: \(dateStr)
    tags: ["\(customDomain)", "asset-manifest", "apple-vision", "computer-vision", "telemetry", "verbatim-ledger"]
    ---

    # Asset Telemetry: Verbatim Computer Vision & Photographic Extraction Ledger

    > [!NOTE] **Tier 2 Machine Data Ledger Invariant:**
    > This document is a **100% unopinionated, script-generated machine ledger** produced locally by `.sos/lib/vision.swift` using Apple's hardware Neural Engine (`Vision.framework` & `CoreImage`). It contains raw telemetry, uneditorialized tag distributions, and verbatim OCR strings. All conceptual, artistic, or narrative synthesis is maintained separately in Tier 1 nodes.

    **Extraction Engine:** Native macOS Apple Vision (`VNClassifyImageRequest`, `VNRecognizeTextRequest`) & `CoreImage` (`CIAreaAverage`)  
    **Dataset Scope:** \(totalCount) Archival Media Assets  
    **Raw JSON Telemetry (Tier 3):** \(jsonLink)  

    ---

    ## 1. Framing & Geometric Ratios

    | Aspect Ratio Classification | Asset Count | Portfolio Share |
    | :--- | :--- | :--- |
    """
    
    for (asp, cnt) in aspectCounts.sorted(by: { $0.value > $1.value }) {
        let pct = Float(cnt) / Float(totalCount) * 100
        md += "\n| `\(asp)` | **\(cnt)** | \(String(format: "%.1f%%", pct)) |"
    }
    
    md += """
    \n\n---

    ## 2. Multi-Signal Lighting & Atmospheric Distribution

    | Lighting Category | Asset Count | Share |
    | :--- | :--- | :--- |
    """
    
    for (lit, cnt) in lightingCounts.sorted(by: { $0.value > $1.value }) {
        let pct = Float(cnt) / Float(totalCount) * 100
        md += "\n| `\(lit)` | **\(cnt)** | \(String(format: "%.1f%%", pct)) |"
    }
    
    md += """
    \n\n---

    ## 3. Apple Vision Neural Tag Frequency Table (Top 30)

    | Neural Scene Tag | Total Detections |
    | :--- | :--- |
    """
    
    for (tag, cnt) in allTagsCount.sorted(by: { $0.value > $1.value }).prefix(30) {
        md += "\n| `\(tag)` | **\(cnt)** |"
    }
    
    // GPS & Geospatial Index (Promoted to Highest Relevance when present)
    let gpsAssets = allResults.filter { $0.exif?.latitude != nil && $0.exif?.longitude != nil }
    if !gpsAssets.isEmpty {
        md += """
        \n\n---

        ## 4. Geospatial Telemetry & Location Index (GPS)

        | Filename | Capture Timestamp | Coordinates (Lat, Lon) | Map Navigation | Camera Hardware |
        | :--- | :--- | :--- | :--- | :--- |
        """
        for item in gpsAssets {
            let lat = item.exif!.latitude!
            let lon = item.exif!.longitude!
            let dt = item.exif!.dateTimeOriginal ?? "N/A"
            let cam = [item.exif!.make, item.exif!.model].compactMap { $0 }.joined(separator: " ")
            let mapLink = "[Apple Maps](https://maps.apple.com/?q=\(lat),\(lon))"
            md += "\n| `\(item.filename)` | `\(dt)` | `\(String(format: "%.5f", lat)), \(String(format: "%.5f", lon))` | \(mapLink) | \(cam) |"
        }
    }
    
    // Camera Hardware & Optical Profile Table (when present)
    let exifAssets = allResults.filter { $0.exif != nil && ($0.exif!.make != nil || $0.exif!.lens != nil || $0.exif!.iso != nil) }
    if !exifAssets.isEmpty {
        md += """
        \n\n---

        ## 5. Camera Hardware & Optical Exif Ledger

        | Filename | Camera Make / Model | Lens / Focal Length | Exposure Settings | Capture Date |
        | :--- | :--- | :--- | :--- | :--- |
        """
        for item in exifAssets.prefix(50) {
            let cam = [item.exif!.make, item.exif!.model].compactMap { $0 }.joined(separator: " ")
            let optics = [item.exif!.lens, item.exif!.focalLength].compactMap { $0 }.joined(separator: " • ")
            let exp = [item.exif!.fNumber, item.exif!.iso, item.exif!.shutterSpeed].compactMap { $0 }.joined(separator: " • ")
            let dt = item.exif!.dateTimeOriginal ?? "N/A"
            md += "\n| `\(item.filename)` | \(cam.isEmpty ? "N/A" : cam) | \(optics.isEmpty ? "N/A" : optics) | \(exp.isEmpty ? "N/A" : exp) | `\(dt)` |"
        }
    }
    
    let sectionNum = (!gpsAssets.isEmpty ? 5 : 4) + (!exifAssets.isEmpty ? 1 : 0)
    md += """
    \n\n---

    ## \(sectionNum). Verbatim OCR Inscription Index

    Verbatim text recognized by `VNRecognizeTextRequest` across inscribed archival images:

    | Filename | Dimensions | Lighting | Neural Scene Tags | Verbatim OCR Recognized Text |
    | :--- | :--- | :--- | :--- | :--- |
    """
    
    let ocrAssets = allResults.filter { $0.ocrText != nil && !$0.ocrText!.isEmpty }
    for item in ocrAssets {
        let ocrStr = item.ocrText!.joined(separator: " • ")
            .replacingOccurrences(of: "|", with: "/")
            .replacingOccurrences(of: "#", with: "\\#")
        let tagStr = item.neuralTags.prefix(3).joined(separator: ", ")
        md += "\n| `\(item.filename)` | `\(item.width)x\(item.height)` | `\(item.lightingCategory)` | `\(tagStr)` | \(ocrStr) |"
    }
    
    md += "\n"
    
    try? md.write(to: URL(fileURLWithPath: outMDPath), atomically: true, encoding: .utf8)
    print("📄 Generated Manifest (Tier 2): \(outMDPath)")
}

// Standard stdout formatting
if doJSON {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    if let data = try? encoder.encode(allResults), let str = String(data: data, encoding: .utf8) {
        print(str)
    }
}
