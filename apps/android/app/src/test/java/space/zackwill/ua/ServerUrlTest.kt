package space.zackwill.ua

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerUrlTest {
    @Test
    fun normalizeStripsSlashesAndV1() {
        assertEquals("https://ua.example.com", ServerUrl.normalize("  https://ua.example.com/v1/ "))
        assertEquals("https://ua.example.com", ServerUrl.normalize("https://ua.example.com///"))
        assertEquals("https://ua.example.com", ServerUrl.normalize("ua.example.com"))
        assertEquals("", ServerUrl.normalize("   "))
    }

    @Test
    fun validateOnlyAcceptsHttps() {
        assertNull(ServerUrl.validate("https://ua.example.com"))
        assertNull(ServerUrl.validate("https://192.168.1.5:8443"))
        assertEquals("只支持 https", ServerUrl.validate("http://ua.example.com"))
        assertEquals("请填写地址", ServerUrl.validate(""))
        assertEquals("地址无效", ServerUrl.validate("https://ua.example.com?x=1"))
    }

    @Test
    fun sameOriginComparesSchemeHostAndPort() {
        val base = "https://ua.example.com"
        assertTrue(ServerUrl.isSameOrigin(base, "https://ua.example.com/#/weeks"))
        assertTrue(ServerUrl.isSameOrigin(base, "https://UA.example.com:443/x"))
        assertFalse(ServerUrl.isSameOrigin(base, "https://claude.ai/settings"))
        assertFalse(ServerUrl.isSameOrigin(base, "http://ua.example.com/"))
        assertFalse(ServerUrl.isSameOrigin(base, "https://ua.example.com:8443/"))
        assertFalse(ServerUrl.isSameOrigin(base, "not a url"))
    }
}
