import Foundation
import PDFKit

guard CommandLine.arguments.count >= 2 else {
    fputs("Usage: swift .sos/lib/pdf.swift <file.pdf>\n", stderr)
    exit(1)
}

let path = CommandLine.arguments[1]
let url = URL(fileURLWithPath: path)
guard FileManager.default.fileExists(atPath: url.path) else {
    fputs("Error: PDF does not exist: \(path)\n", stderr)
    exit(1)
}
guard let document = PDFDocument(url: url) else {
    fputs("Error: Could not open PDF: \(path)\n", stderr)
    exit(1)
}
if document.isLocked {
    fputs("Error: PDF is encrypted: \(path)\n", stderr)
    exit(1)
}

var parts: [String] = []
for index in 0..<document.pageCount {
    guard let page = document.page(at: index) else { continue }
    let text = (page.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if text.isEmpty { continue }
    parts.append("## Page \(index + 1)\n\n\(text)")
}

print(parts.joined(separator: "\n\n"))
