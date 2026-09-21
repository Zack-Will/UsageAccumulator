/**
 * 极简日志。**任何情况下都不写 token / sessionKey。**
 * 所有对外可见的字符串在进这里之前必须先过 redact()。
 */
import Foundation

enum Log {
    /// 把可能混进 URL / 错误信息里的凭证抹掉。
    static func redact(_ input: String) -> String {
        var out = input
        let rules: [(String, String)] = [
            ("Bearer\\s+[\\w.\\-~+/]+=*", "Bearer ***"),
            ("([?&](?:token|access_token|machine_token|key|sessionKey)=)[^&\\s]*", "$1***"),
            ("//[^/@\\s]+@", "//***@"),
        ]
        for (pattern, replacement) in rules {
            guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { continue }
            out = re.stringByReplacingMatches(
                in: out,
                range: NSRange(out.startIndex..., in: out),
                withTemplate: replacement
            )
        }
        return out
    }

    private static func emit(_ level: String, _ msg: String) {
        FileHandle.standardError.write(Data("[ua-menubar-mac] \(level) \(redact(msg))\n".utf8))
    }

    static func info(_ msg: String) { emit("info", msg) }
    static func warn(_ msg: String) { emit("warn", msg) }
    static func error(_ msg: String) { emit("error", msg) }

    /// 把任意 Error 压成一句脱敏短语。
    static func text(_ err: Error) -> String { redact((err as NSError).localizedDescription) }
}
