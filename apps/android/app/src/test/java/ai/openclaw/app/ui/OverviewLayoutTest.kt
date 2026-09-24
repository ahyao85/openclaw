package ai.openclaw.app.ui

import ai.openclaw.app.AndroidScreenshotFixture
import ai.openclaw.app.AndroidScreenshotScene
import ai.openclaw.app.AppearanceThemeMode
import ai.openclaw.app.GatewayAgentSummary
import ai.openclaw.app.GatewayNodeCapabilityApproval
import ai.openclaw.app.GatewayNodesDevicesSummary
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.chat.ChatController
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.ui.chat.RichBlockWebViewFeatureShadow
import ai.openclaw.app.ui.design.clawColorsForTheme
import ai.openclaw.app.ui.design.renderedLabelContrast
import android.content.Context
import android.graphics.Bitmap
import android.provider.Settings
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.rules.RuleChain
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.util.ReflectionHelpers
import java.io.File
import java.util.UUID

/** Exercises the real shell -> Overview boundary with an isolated, in-memory runtime. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "en-rUS-w412dp-h915dp-mdpi", instrumentedPackages = ["ai.openclaw.app.AndroidScreenshotFixture", "androidx.webkit"], shadows = [RichBlockWebViewFeatureShadow::class])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class OverviewLayoutTest {
  private val composeRule = createComposeRule()
  private val models = ViewModelStore()
  private lateinit var app: NodeApp
  private lateinit var prefs: SecurePrefs
  private lateinit var runtime: NodeRuntime
  private lateinit var model: MainViewModel
  private var previousRuntime: NodeRuntime? = null
  private var restoreAnimatorScale: (() -> Unit)? = null
  private val evidence by lazy {
    File("build/outputs/overview-layout", UUID.randomUUID().toString()).also { check(it.mkdirs()) }
  }

  @get:Rule
  val fixtureRules: RuleChain =
    RuleChain
      .outerRule(
        object : ExternalResource() {
          override fun after() {
            try {
              models.clear()
            } finally {
              try {
                if (::runtime.isInitialized) closeNodeRuntimeTestFixture(runtime)
              } finally {
                try {
                  if (::app.isInitialized) bindNodeRuntimeTestFixture(app, previousRuntime)
                } finally {
                  AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
                  restoreAnimatorScale?.invoke()
                }
              }
            }
          }
        },
      ).around(composeRule)

  @Before
  fun setUp() {
    app = RuntimeEnvironment.getApplication() as NodeApp
    previousRuntime = app.peekRuntime()
    val resolver = app.contentResolver
    val originalScale = Settings.Global.getString(resolver, Settings.Global.ANIMATOR_DURATION_SCALE)
    restoreAnimatorScale = { Settings.Global.putString(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, originalScale) }
    Settings.Global.putFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
    prefs = SecurePrefs(app, app.getSharedPreferences("overview-layout-" + UUID.randomUUID(), Context.MODE_PRIVATE))
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
    runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    bindNodeRuntimeTestFixture(app, runtime)
    model = MainViewModel(app, prefs, SavedStateHandle())
    models.put("overview", model)
    model.enterScreenshotFixtureMode(AndroidScreenshotScene.Home)
    ReflectionHelpers.getField<MutableStateFlow<List<ai.openclaw.app.GatewayCronJobSummary>>>(runtime, "_cronJobs").value = emptyList()
  }

  @Test
  fun sidebarHomeLeavesTheSelectedSecondarySession() {
    model.switchChatSession("agent:main:sidebar-proof", "main")
    composeRule.setContent { ShellScreen(model) }
    composeRule.onNodeWithContentDescription("Show Sidebar").performClick()
    capture("home-sidebar")
    composeRule.onNode(hasText("Home") and SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Tab)).performClick()
    capture("home-selected-chat")
    composeRule.runOnIdle {
      assertEquals("agent:main:main", model.chatSessionKey.value)
    }
  }

  @Test
  fun normalOverviewFitsFiveRecentSessionsAndUsesSelectedAgent() {
    val sessions =
      (1..5).map { ChatSessionEntry(key = "agent:scout:proof-$it", ownerAgentId = "scout", displayName = "Recent session $it", updatedAtMs = it.toLong()) } +
        ChatSessionEntry(key = "agent:scout:main", ownerAgentId = "scout", displayName = "Main must be excluded", updatedAtMs = 100) +
        ChatSessionEntry(key = "agent:main:other", ownerAgentId = "main", displayName = "Other agent must be excluded", updatedAtMs = 101)
    model.switchChatSession("agent:scout:secondary", "scout")
    val chat = ReflectionHelpers.getField<ChatController>(runtime, "chat")
    ReflectionHelpers.callInstanceMethod<Unit>(chat, "publishSessions", ReflectionHelpers.ClassParameter.from(List::class.java, sessions))
    ReflectionHelpers.getField<MutableStateFlow<List<GatewayAgentSummary>>>(runtime, "_gatewayAgents").value =
      listOf(
        GatewayAgentSummary("main", "Default agent", null),
        GatewayAgentSummary("scout", "Scout", null),
      )
    composeRule.setContent { ShellScreen(model) }
    composeRule.waitUntil { !model.chatHistoryLoading.value }
    composeRule.runOnIdle {
      ReflectionHelpers.callInstanceMethod<Unit>(chat, "publishSessions", ReflectionHelpers.ClassParameter.from(List::class.java, sessions))
    }
    composeRule.onNode(hasText("Scout") and hasAnyAncestor(hasTestTag("overview-content"))).assertIsDisplayed()
    composeRule.onNode(hasText("Default agent") and hasAnyAncestor(hasTestTag("overview-content"))).assertDoesNotExist()
    composeRule.onNodeWithText("Main must be excluded").assertDoesNotExist()
    composeRule.onNodeWithText("Other agent must be excluded").assertDoesNotExist()
    composeRule.onNodeWithText("Recent session 1").assertIsDisplayed()
    composeRule.onNodeWithTag("overview-files").assertIsDisplayed()
    composeRule.onNodeWithTag("overview-attention").assertDoesNotExist()
    capture("normal-five-recents")
    composeRule.onNode(hasText("Home") and hasAnyAncestor(hasTestTag("overview-content"))).performClick()
    composeRule.runOnIdle { assertEquals("agent:scout:main", model.chatSessionKey.value) }
  }

  @Test
  fun homeUsesTheThemePrimaryActionInDarkAndLightModes() {
    composeRule.setContent { ShellScreen(model) }
    val paints = mutableListOf<Pair<Int, Int>>()
    for (dark in listOf(true, false)) {
      composeRule.runOnIdle { prefs.setAppearanceThemeMode(if (dark) AppearanceThemeMode.Dark else AppearanceThemeMode.Light) }
      val chat =
        composeRule
          .onNode(hasText("Home") and hasAnyAncestor(hasTestTag("overview-content")))
          .performScrollTo()
          .assertIsDisplayed()
          .assertHasClickAction()
      capture(if (dark) "primary-dark" else "primary-light")
      val pixels = chat.captureToImage().toPixelMap()
      paints += clawColorsForTheme(dark = dark, accentArgb = null).primary.toArgb() to pixels[pixels.width / 2, 4].toArgb()
    }
    paints.forEach { (expected, actual) ->
      assertEquals("Chat must paint the shared primary color, not another gray panel", expected, actual)
    }
  }

  @Test
  fun talkSettingsStillOpensVoiceSettingsRatherThanTheTalkRow() {
    composeRule.setContent { ShellScreen(model) }
    composeRule.onNodeWithContentDescription("Talk settings").performScrollTo().performClick()
    composeRule.onNodeWithText("Configure wake words, talk, and playback.").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Back").performClick()
    composeRule.onNode(hasScrollToIndexAction() and hasAnyDescendant(hasText("Recent sessions"))).assertIsDisplayed()
  }

  @Test
  fun overviewStatusKeepsReadableSemanticFillAcrossConnectionStatesAndThemes() {
    composeRule.setContent { ShellScreen(model) }
    val failures = mutableListOf<String>()
    for (label in listOf("Online", "Needs you", "Offline")) {
      composeRule.runOnIdle {
        when (label) {
          "Needs you" -> {
            // Publish a synthetic pending-node snapshot through the existing runtime state contract.
            val nodes = ReflectionHelpers.getField<MutableStateFlow<GatewayNodesDevicesSummary>>(runtime, "_nodesDevicesSummary")
            nodes.value = nodes.value.copy(nodes = nodes.value.nodes.map { it.copy(approvalState = GatewayNodeCapabilityApproval.Unapproved) })
          }

          "Offline" -> {
            runtime.disconnect()
          }
        }
      }
      for (dark in listOf(true, false)) {
        composeRule.runOnIdle { prefs.setAppearanceThemeMode(if (dark) AppearanceThemeMode.Dark else AppearanceThemeMode.Light) }
        val status = hasText(if (label == "Needs you") "Online" else label) and hasClickAction() and !hasContentDescription("Open Gateway") and !hasContentDescription("Open Files")
        val control = composeRule.onNode(status).assertIsDisplayed().assertHasClickAction()
        val text = composeRule.onAllNodesWithText(if (label == "Needs you") "Online" else label, useUnmergedTree = true)[0]
        val labelBounds = text.fetchSemanticsNode().boundsInRoot
        val controlBounds = control.fetchSemanticsNode().boundsInRoot
        assertTrue("Contrast must measure the dropdown label", labelBounds.top >= controlBounds.top && labelBounds.bottom <= controlBounds.bottom)
        val contrast = renderedLabelContrast(label = text, container = control)
        assertTrue("Status dropdown must retain its 48dp hit area", control.fetchSemanticsNode().size.height >= 48)
        capture("status-" + label.replace(' ', '-') + if (dark) "-dark" else "-light")
        println("OVERVIEW_STATUS_CONTRAST label=$label dark=$dark ratio=" + contrast.ratio + " background=" + contrast.background.toArgb())
        if (contrast.ratio < 4.5f) failures += "$label dark=$dark: " + contrast.ratio
      }
    }
    composeRule.onNode(hasText("Offline") and hasClickAction() and !hasContentDescription("Open Gateway") and !hasContentDescription("Open Files")).performClick()
    composeRule.onAllNodesWithText("Gateway")[0].assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Back").performClick()
    composeRule.onNodeWithText("Reconnect").assertIsDisplayed().assertHasClickAction()
    assertTrue("Overview status text must retain at least 4.5:1 rendered contrast: " + failures.joinToString(), failures.isEmpty())
  }

  @Test
  fun overviewControlsKeepTheirSettingsAndSessionDestinations() {
    composeRule.setContent { ShellScreen(model) }
    for ((control, heading) in listOf("Online" to "Gateway", "Automations" to "Automations", "Devices" to "Nodes & Devices", "Approvals" to "Approvals")) {
      composeRule.onNode(hasText(control) and hasAnyAncestor(hasTestTag("overview-content"))).performScrollTo().performClick()
      composeRule.onAllNodesWithText(heading).fetchSemanticsNodes().let { assertTrue("Destination heading $heading", it.isNotEmpty()) }
      composeRule.onNodeWithContentDescription("Back").performClick()
      composeRule.onNodeWithTag("overview-content").assertIsDisplayed()
    }
    composeRule.onNodeWithContentDescription("Open Agents").performClick()
    composeRule.onAllNodesWithText("Agents").fetchSemanticsNodes().let { assertTrue(it.isNotEmpty()) }
    composeRule.onNodeWithContentDescription("Back").performClick()
    composeRule.onNodeWithTag("overview-files").performScrollTo().performClick()
    composeRule.onNodeWithContentDescription("Back").performClick()
    composeRule.onNode(hasText("Runs") and hasAnyAncestor(hasTestTag("overview-content"))).performScrollTo().performClick()
    composeRule.onNodeWithContentDescription("Session options").assertIsDisplayed()
  }

  @Test
  @Config(qualifiers = "en-rUS-w320dp-h800dp-mdpi")
  fun largeTextKeepsWarningsAndAllDestinationsReachable() {
    model.setAppearanceTextScale(ai.openclaw.app.AppearanceTextScale.Largest)
    val nodes = ReflectionHelpers.getField<MutableStateFlow<GatewayNodesDevicesSummary>>(runtime, "_nodesDevicesSummary")
    nodes.value = nodes.value.copy(nodes = nodes.value.nodes.map { it.copy(approvalState = GatewayNodeCapabilityApproval.Unapproved) })
    composeRule.setContent { OpenClawTheme(textScale = ai.openclaw.app.AppearanceTextScale.Largest) { ShellScreen(model) } }
    composeRule.onNodeWithText("Needs you").performScrollTo().assertIsDisplayed()
    composeRule.onNodeWithText("Node approval pending").performScrollTo().assertIsDisplayed()
    composeRule.onNodeWithTag("overview-content").performScrollToNode(hasTestTag("overview-files"))
    composeRule.onNodeWithTag("overview-files").assertIsDisplayed()
    composeRule.onNodeWithTag("overview-content").performScrollToNode(hasText("Home"))
    composeRule.onNode(hasText("Home") and hasAnyAncestor(hasTestTag("overview-content"))).assertIsDisplayed()
    val layouts = mutableListOf<TextLayoutResult>()
    composeRule
      .onNode(hasText("Home") and hasAnyAncestor(hasTestTag("overview-content")), useUnmergedTree = true)
      .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
    assertEquals(
      "Proof must use the Activity's 140% text scale",
      1.4f,
      layouts
        .single()
        .layoutInput.density.fontScale,
      0.001f,
    )
    capture("large-text")
  }

  @Test
  fun realOverviewLoadsBeyondFiftyCountsDistinctSessionsAndBoundsOnlyItsPreview() {
    val chat = ReflectionHelpers.getField<ChatController>(runtime, "chat")
    val original = ReflectionHelpers.getField<suspend (String, String?) -> String>(chat, "requestGateway")

    fun page(
      size: Int,
      total: Int? = null,
      more: Boolean = false,
    ): String {
      val rows =
        (1..size).map { index ->
          val key = if (index == 1) "agent:main:main" else "agent:main:count-$index"
          """{"key":"$key","displayName":"Count session $index","updatedAt":$index}"""
        }
      return """{"sessions":[${(rows + rows.last()).joinToString(",")}],"hasMore":$more${total?.let { ",\"totalCount\":$it" }.orEmpty()}}"""
    }
    val response =
      java.util.concurrent.atomic
        .AtomicReference(page(75))
    val requestedLimits = java.util.concurrent.ConcurrentLinkedQueue<Int>()
    val requester: suspend (String, String?) -> String = { method, params ->
      if (method == "sessions.list") {
        val request =
          kotlinx.serialization.json.Json
            .parseToJsonElement(params.orEmpty()) as kotlinx.serialization.json.JsonObject
        requestedLimits += (request["limit"] as? kotlinx.serialization.json.JsonPrimitive)?.content?.toIntOrNull() ?: 0
        response.get()
      } else if (method == "chat.history") {
        val request =
          kotlinx.serialization.json.Json
            .parseToJsonElement(params.orEmpty()) as kotlinx.serialization.json.JsonObject
        val history =
          kotlinx.serialization.json.Json
            .parseToJsonElement(original(method, params)) as kotlinx.serialization.json.JsonObject
        val info = history["sessionInfo"] as kotlinx.serialization.json.JsonObject
        kotlinx.serialization.json
          .JsonObject(history + ("sessionInfo" to kotlinx.serialization.json.JsonObject(info + ("key" to requireNotNull(request["sessionKey"])))))
          .toString()
      } else {
        original(method, params)
      }
    }
    ReflectionHelpers.setField(chat, "requestGateway", requester)
    val scopedRequester: suspend (String, String, String?) -> String = { _, method, params -> requester(method, params) }
    ReflectionHelpers.setField(chat, "requestGatewayForGateway", scopedRequester)
    val captureLease: (ai.openclaw.app.chat.ChatCacheScope?) -> ai.openclaw.app.gateway.GatewaySession.RequestLease? = { scope ->
      ai.openclaw.app.gateway.GatewaySession.RequestLease(endpointStableId = scope?.gatewayId.orEmpty()) { method, params, _, withEnqueue ->
        withEnqueue {}
        requester(method, params)
      }
    }
    ReflectionHelpers.setField(chat, "captureRequestLease", captureLease)
    // Keep the selected row inside the synthetic server page; retained off-page rows
    // have their own count contract in ChatControllerSessionSearchTest.
    model.switchChatSession("agent:main:main", "main")
    composeRule.setContent { ShellScreen(model) }
    composeRule.waitUntil { runtime.chatSessionListCount.value?.value == 75L }
    composeRule.waitForIdle()
    composeRule.onNodeWithText("See all 75").assertIsDisplayed()
    assertTrue("Overview must request the standard full list, not a 50-row preview", requestedLimits.contains(200))
    composeRule.onNodeWithText("Count session 1").assertDoesNotExist()
    composeRule.onAllNodesWithTag("overview-recent-session").assertCountEquals(5)
    composeRule.onNodeWithTag("overview-files").assertIsDisplayed()
    capture("count-75")
    response.set(page(200, more = true))
    composeRule.runOnIdle { model.refreshChatSessions(limit = 200) }
    composeRule.waitForIdle()
    // The IO-owned result settles before the Main-thread ViewModel projection in
    // Robolectric. Await that owner, then drain Compose before asserting the label.
    composeRule.waitUntil { runtime.chatSessionListCount.value?.value == 200L }
    composeRule.waitForIdle()
    composeRule.onNodeWithText("See all 200+").assertIsDisplayed()
    composeRule.onAllNodesWithTag("overview-recent-session").assertCountEquals(5)
    capture("count-200-plus")
    response.set(page(200, total = 420, more = true))
    composeRule.runOnIdle { model.refreshChatSessions(limit = 200) }
    composeRule.waitForIdle()
    composeRule.waitUntil { runtime.chatSessionListCount.value?.value == 420L }
    composeRule.waitForIdle()
    composeRule.onNodeWithText("See all 420").assertIsDisplayed()
  }

  @Test
  fun overviewTalkSelectsMainAndAttemptsCaptureAfterPermissionAndSetup() {
    org.robolectric.Shadows
      .shadowOf(app)
      .grantPermissions(android.Manifest.permission.RECORD_AUDIO)
    model.switchChatSession("agent:scout:secondary", "scout")
    val deviceKey = runtime.mainSessionKey.value
    composeRule.setContent { ShellScreen(model) }
    composeRule.onNode(hasText("Talk") and hasAnyAncestor(hasTestTag("overview-content"))).performClick()
    composeRule.waitUntil { runtime.talkFailureNotice.value != null }
    composeRule.waitForIdle()
    assertEquals("agent:scout:main", model.chatSessionKey.value)
    assertEquals(deviceKey, runtime.mainSessionKey.value)
    // This fixture has no live operator socket: reaching its transport error proves
    // Talk was attempted, rather than merely changing tabs. Wire target proof lives
    // in TalkModeManagerTest with a real local Gateway WebSocket.
    assertTrue(requireNotNull(runtime.talkFailureNotice.value).text.contains("not connected", ignoreCase = true))
  }

  private fun capture(name: String) {
    val image = composeRule.onRoot().captureToImage().asAndroidBitmap()
    assertTrue("Capture must include the full phone root", image.width >= 320 && image.height >= 700)
    File(evidence, "$name.png").outputStream().use { stream ->
      assertTrue(image.compress(Bitmap.CompressFormat.PNG, 100, stream))
    }
    println("OVERVIEW_LAYOUT_PROOF " + File(evidence, "$name.png").absolutePath)
  }
}
