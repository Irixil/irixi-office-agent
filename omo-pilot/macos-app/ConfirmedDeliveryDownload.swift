import Foundation

enum ConfirmedDeliveryDownload {
    enum Failure: LocalizedError {
        case request(String)
        case invalidResponse
        case httpStatus(Int)
        case missingData
        case invalidDocumentType

        var errorDescription: String? {
            switch self {
            case .request(let reason): return "下载失败（\(reason)）；原成果仍保留，请检查连接后重试。"
            case .invalidResponse: return "下载响应无效；原成果仍保留。"
            case .httpStatus(let status): return "下载未成功（HTTP \(status)）；原成果仍保留。"
            case .missingData: return "没有收到可保存的内容；原成果仍保留。"
            case .invalidDocumentType: return "返回内容不是 Markdown 文档，未保存；原成果仍保留。"
            }
        }
    }

    static func validatedData(data: Data?, response: URLResponse?, error: Error?, isDocument: Bool) throws -> Data {
        if let error { throw Failure.request(error.localizedDescription) }
        guard let http = response as? HTTPURLResponse else { throw Failure.invalidResponse }
        guard (200...299).contains(http.statusCode) else { throw Failure.httpStatus(http.statusCode) }
        guard let data else { throw Failure.missingData }
        if isDocument && !["text/markdown", "text/plain"].contains(http.mimeType?.lowercased() ?? "") {
            throw Failure.invalidDocumentType
        }
        return data
    }
}
