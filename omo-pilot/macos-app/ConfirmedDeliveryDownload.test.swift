import Foundation

@main
struct ConfirmedDeliveryDownloadTests {
    static func main() throws {
        let url = URL(string: "http://127.0.0.1/document")!
        let markdownResponse = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil,
            headerFields: ["Content-Type": "text/markdown; charset=utf-8"] )!
        let markdown = Data("# 已确认成果\n".utf8)
        let validMarkdown = try ConfirmedDeliveryDownload.validatedData(data: markdown, response: markdownResponse,
            error: nil, isDocument: true)
        assert(validMarkdown == markdown)

        let errorResponse = HTTPURLResponse(url: url, statusCode: 409, httpVersion: nil,
            headerFields: ["Content-Type": "application/json"] )!
        do {
            _ = try ConfirmedDeliveryDownload.validatedData(data: Data("{\"error\":true}".utf8),
                response: errorResponse, error: nil, isDocument: true)
            fatalError("HTTP errors must never be treated as a document download")
        } catch ConfirmedDeliveryDownload.Failure.httpStatus(let status) {
            assert(status == 409)
        }

        let wrongType = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil,
            headerFields: ["Content-Type": "application/json"] )!
        do {
            _ = try ConfirmedDeliveryDownload.validatedData(data: Data("{}".utf8), response: wrongType,
                error: nil, isDocument: true)
            fatalError("non-document responses must not be saved as Markdown")
        } catch ConfirmedDeliveryDownload.Failure.invalidDocumentType {}

        print("Confirmed Markdown download checks passed: success, HTTP error, wrong content type")
    }
}
