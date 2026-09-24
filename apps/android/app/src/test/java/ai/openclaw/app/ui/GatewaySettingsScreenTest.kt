package ai.openclaw.app.ui

import ai.openclaw.app.AndroidScreenshotFixture
import ai.openclaw.app.AndroidScreenshotScene
import ai.openclaw.app.GatewayApprovalKind
import ai.openclaw.app.GatewayExecApprovalInboxState
import ai.openclaw.app.GatewayExecApprovalSummary
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import ai.openclaw.app.i18n.resolveNativeText
import ai.openclaw.app.i18n.verbatimText
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.content.Context
import android.graphics.Bitmap
import android.provider.Settings
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.DeviceConfigurationOverride
import androidx.compose.ui.test.FontScale
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
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
import java.util.Base64
import java.util.UUID

/** Exercises Gateway and Approvals through their real Settings routes and isolated runtime. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "en-rUS-w360dp-h800dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class GatewaySettingsScreenTest {
  private val composeRule = createComposeRule()
  private val models = ViewModelStore()
  private lateinit var app: NodeApp
  private lateinit var prefs: SecurePrefs
  private lateinit var runtime: NodeRuntime
  private lateinit var model: MainViewModel
  private var previousRuntime: NodeRuntime? = null
  private var animatorScale: String? = null

  // Compose consumers must be disposed before joining runtime cleanup.
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
                if (::app.isInitialized) {
                  bindNodeRuntimeTestFixture(app, previousRuntime)
                  Settings.Global.putString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, animatorScale)
                }
                AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
              }
            }
          }
        },
      ).around(composeRule)

  @Test
  fun unpairedGatewayOffersPairingWithoutInactiveConnectionActions() {
    showSettings(paired = false)
    capture("unpaired-gateway")
    composeRule.onNodeWithText("Scan QR to Pair").assertIsDisplayed().performClick()
    composeRule.runOnIdle { assertNotNull(model.gatewayAdditionRequest.value) }
    composeRule.onNodeWithText("Reconnect").assertDoesNotExist()
    composeRule.onNodeWithText("Disconnect").assertDoesNotExist()
    composeRule.onNodeWithText("Connection").assertDoesNotExist()
    composeRule.onAllNodesWithText("Offline").assertCountEquals(1)
  }

  @Test
  fun connectedGatewayShowsOneStatusAndDisconnectUpdatesTheSameRow() {
    showSettings(connected = true)
    capture("connected-gateway")
    composeRule.onNodeWithText("Connection").assertDoesNotExist()
    composeRule.onAllNodesWithText("Connected").assertCountEquals(1)
    composeRule.onNodeWithText("Ready").assertDoesNotExist()
    composeRule.onNodeWithText("Disconnect").performClick()
    composeRule.onNodeWithText("Offline").assertIsDisplayed()
    composeRule.onNodeWithText("Reconnect").assertIsDisplayed()
    composeRule.runOnIdle { assertEquals(1, prefs.gatewayRegistry.entries.value.size) }
    capture("disconnected-gateway")
  }

  @Test
  fun connectionActionsAndSavedGatewaysPrecedeCollapsedTechnicalDetails() {
    showSettings()
    capture("connection-actions")
    composeRule.onNodeWithText("Reconnect").assertIsDisplayed()
    composeRule.onNodeWithText("Disconnect").assertIsDisplayed()
    val actions = composeRule.onNodeWithText("Reconnect").getUnclippedBoundsInRoot()
    val saved = composeRule.onNodeWithText("Local QA Gateway").getUnclippedBoundsInRoot()
    assertTrue("Connection actions precede saved gateways", actions.bottom <= saved.top)
    composeRule.onNodeWithText("Instance ID").assertDoesNotExist()
    composeRule.onNodeWithContentDescription("Host").assertDoesNotExist()
    composeRule.onNode(hasSetTextAction() and hasText("Setup code")).assertDoesNotExist()

    val entries = prefs.gatewayRegistry.entries.value
    composeRule.onNodeWithText("Add Gateway").performScrollTo().performClick()
    composeRule.runOnIdle {
      assertNotNull(model.gatewayAdditionRequest.value)
      assertEquals(entries, prefs.gatewayRegistry.entries.value)
      model.dismissGatewayAddition(requireNotNull(model.gatewayAdditionRequest.value))
    }
    composeRule.onNodeWithText("Diagnostics").performScrollTo().performClick()
    composeRule.onNodeWithText("Instance ID").performScrollTo().assertIsDisplayed()
    composeRule.onNodeWithText("Diagnose").performScrollTo().assertIsDisplayed()
  }

  @Test
  fun invalidSetupCodeShowsErrorBesideItsActionWithoutChangingSavedSettings() {
    showSettings()
    openManualSettings()
    val entries = prefs.gatewayRegistry.entries.value
    val code = composeRule.onNode(hasSetTextAction() and hasText("Setup code"))
    code.performScrollTo().performTextReplacement("not a setup code")
    val connect = composeRule.onNodeWithText("Connect").performScrollTo().performClick()
    val message = "Enter a valid setup code or gateway address."
    val error = composeRule.onNodeWithText(message)
    connect.performScrollTo()
    capture("invalid-setup-code")
    error.assertIsDisplayed()
    code.assertIsDisplayed()
    composeRule.onAllNodesWithText(message).assertCountEquals(1)
    assertTrue("Setup validation belongs above its Connect action", error.getUnclippedBoundsInRoot().bottom <= connect.getUnclippedBoundsInRoot().top)
    composeRule.runOnIdle {
      assertEquals(entries, prefs.gatewayRegistry.entries.value)
      assertEquals("127.0.0.1", prefs.manualHost.value)
      assertEquals(18789, prefs.manualPort.value)
    }
    code.performTextReplacement("correcting the code")
    error.assertDoesNotExist()
  }

  @Test
  fun populatedManualFieldsKeepLabelsAndSecretsStayMasked() {
    showSettings()
    openManualSettings()
    val fields =
      listOf(
        Triple("Host", "127.0.0.1", "192.168.0.25"),
        Triple("Port", "18789", "18790"),
        Triple("Token", "Token", "synthetic-token"),
        Triple("Bootstrap", "Bootstrap", "synthetic-bootstrap"),
        Triple("Password", "Password", "synthetic-password"),
      )
    for ((_, initial, value) in fields) {
      composeRule.onNode(hasSetTextAction() and hasText(initial)).performScrollTo().performTextReplacement(value)
    }
    composeRule.onNodeWithText("Save & Connect").performScrollTo()
    capture("populated-manual-fields")
    for ((label, _, _) in fields) {
      val field = composeRule.onNodeWithContentDescription(label)
      field.performScrollTo()
      composeRule.onNodeWithText(label, useUnmergedTree = true).assertIsDisplayed()
      field.assert(
        if (label == "Host" || label == "Port") {
          SemanticsMatcher.keyNotDefined(SemanticsProperties.Password)
        } else {
          SemanticsMatcher.keyIsDefined(SemanticsProperties.Password)
        },
      )
    }
    composeRule.runOnIdle {
      assertEquals("Editing is not persistence", "127.0.0.1", prefs.manualHost.value)
      assertEquals(18789, prefs.manualPort.value)
    }
  }

  @Test
  fun setupReplacementStillRequiresConfirmationAndCancelPreservesSavedGateway() {
    showSettings()
    val entries = prefs.gatewayRegistry.entries.value
    val code =
      Base64.getUrlEncoder().withoutPadding().encodeToString(
        """{"url":"ws://127.0.0.1:18789","bootstrapToken":"synthetic-replacement"}""".toByteArray(),
      )
    openManualSettings()
    composeRule.onNode(hasSetTextAction() and hasText("Setup code")).performScrollTo().performTextReplacement(code)
    composeRule.onNodeWithText("Connect").performScrollTo().performClick()
    composeRule.onNodeWithText("Replace gateway setup?").assertIsDisplayed()
    composeRule.onNodeWithText("Cancel").performClick()
    composeRule.onNodeWithText("Replace gateway setup?").assertDoesNotExist()
    composeRule.runOnIdle { assertEquals(entries, prefs.gatewayRegistry.entries.value) }
  }

  @Test
  fun technicalDisclosuresAnnounceExpansionRatherThanSelection() {
    showSettings()
    for (label in listOf("Discovered", "Diagnostics", "Manual Gateway")) {
      val disclosure = composeRule.onNode(hasText(label) and hasClickAction())
      disclosure.performScrollTo()
      disclosure.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Collapsed"))
      disclosure.assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.Selected))
      disclosure.performClick()
      disclosure.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Expanded"))
      disclosure.performScrollTo().performClick()
      disclosure.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Collapsed"))
    }
  }

  @Test
  fun approvalShowsOneFullCommandAndCompactUnabridgedDecisions() {
    showSettings(connected = true, route = SettingsRoute.Approvals)
    val approval = showApproval(GatewayApprovalKind.Exec)
    composeRule.onNodeWithText("Deny").performScrollTo()
    capture("exec-approval")
    val command = approval.commandText.resolveNativeText()
    composeRule.onAllNodesWithText(command).assertCountEquals(1)
    val commandLayout = textLayout(command)
    assertEquals(FontFamily.Monospace, commandLayout.layoutInput.style.fontFamily)
    assertTrue("The entire command remains readable", !commandLayout.hasVisualOverflow)
    val labels = listOf("Allow once", "Always allow here", "Deny")
    labels.forEach(::assertReadableAction)
    val buttons = labels.map { composeRule.onNodeWithText(it).getUnclippedBoundsInRoot() }
    assertEquals(buttons[0].top, buttons[1].top)
    assertEquals(buttons[0].top, buttons[2].top)
    val widths = buttons.map { it.right - it.left }
    assertTrue("Equal weights differ by at most one rounding pixel", widths.max() - widths.min() <= 1.dp)
    assertTrue(buttons[1].left >= buttons[0].right && buttons[2].left >= buttons[1].right)
    composeRule.onNodeWithText("Review").assertIsDisplayed()
    composeRule.onNodeWithText("Deny").performClick()
    runBlocking { withTimeout(5_000) { runtime.execApprovalInbox.first { state -> state.approvals.none { it.id == approval.id } } } }
    composeRule.onNodeWithText(command).assertDoesNotExist()
  }

  @Test
  fun largeTextKeepsPluginDetailsAndDisabledDecisionsThenRespectsExternalResolution() {
    showSettings(connected = true, route = SettingsRoute.Approvals, fontScale = 2f, dark = false)
    val approval = showApproval(GatewayApprovalKind.Plugin)
    composeRule.onNodeWithText("Deny").performScrollTo()
    capture("plugin-approval-large-text")
    val labels = listOf("Allow once", "Always allow", "Deny")
    labels.forEach(::assertReadableAction)
    val buttons = labels.map { composeRule.onNodeWithText(it).getUnclippedBoundsInRoot() }
    assertTrue("Full labels stack at large text", buttons[1].top >= buttons[0].bottom && buttons[2].top >= buttons[1].bottom)
    composeRule.onNodeWithText("Prepared plugin action").performScrollTo().assertIsDisplayed()
    composeRule.onNodeWithText("Review this plugin's complete description.").performScrollTo().assertIsDisplayed()
    composeRule.onNodeWithText("Review the destination before allowing.").performScrollTo().assertIsDisplayed()
    composeRule.runOnIdle { approvalState().value = GatewayExecApprovalInboxState(approvals = listOf(approval.copy(resolvingDecision = "deny"))) }
    composeRule.onNodeWithText("Sending").performScrollTo().assertIsDisplayed()
    labels.forEach { composeRule.onNodeWithText(it).performScrollTo().assertIsNotEnabled() }
    composeRule.runOnIdle {
      approvalState().value = GatewayExecApprovalInboxState(approvals = listOf(approval.copy(externalResolutionDecisions = listOf("allow-always"), externalResolutionLabel = "Always allow requires Control UI review.")))
    }
    composeRule.onNodeWithText("Always allow").assertDoesNotExist()
    composeRule.onNodeWithText("Always allow requires Control UI review.").performScrollTo().assertIsDisplayed()
    composeRule.onNodeWithText("Allow once").performScrollTo().assertIsEnabled()
    composeRule.onNodeWithText("Deny").performScrollTo().assertIsEnabled()
  }

  private fun showApproval(kind: GatewayApprovalKind): GatewayExecApprovalSummary {
    val loaded = runBlocking { withTimeout(5_000) { runtime.execApprovalInbox.first { !it.refreshing && it.approvals.size == 3 } } }
    val approval =
      loaded.approvals.single { it.kind == kind }.copy(
        allowedDecisions = listOf("allow-once", "allow-always", "deny"),
        commandPreview = if (kind == GatewayApprovalKind.Exec) "pnpm android:test:integration" else "Prepared plugin action",
        commandText = verbatimText(if (kind == GatewayApprovalKind.Exec) "pnpm android:test:integration" else "Review this plugin's complete description."),
        warningText = "Review the destination before allowing.",
        createdAtMs = null,
        expiresAtMs = null,
      )
    composeRule.runOnIdle { approvalState().value = GatewayExecApprovalInboxState(approvals = listOf(approval)) }
    return approval
  }

  private fun approvalState(): MutableStateFlow<GatewayExecApprovalInboxState> = ReflectionHelpers.getField(runtime, "mutableExecApprovalInbox")

  private fun textLayout(text: String): TextLayoutResult {
    val layouts = mutableListOf<TextLayoutResult>()
    composeRule.onNodeWithText(text, useUnmergedTree = true).performSemanticsAction(SemanticsActions.GetTextLayoutResult) { assertTrue(it(layouts)) }
    return layouts.single()
  }

  private fun assertReadableAction(label: String) {
    val button =
      composeRule
        .onNodeWithText(label)
        .performScrollTo()
        .assertIsDisplayed()
        .assertIsEnabled()
    val layout = textLayout(label)
    val bounds = button.fetchSemanticsNode().touchBoundsInRoot
    val contentWidth = bounds.width - with(composeRule.density) { 16.dp.toPx() }
    assertTrue("$label has room for every line", !layout.didOverflowHeight)
    for (line in 0 until layout.lineCount) {
      assertTrue("$label is not ellipsized", !layout.isLineEllipsized(line))
      assertTrue("$label fits inside its button", layout.getLineRight(line) - layout.getLineLeft(line) <= contentWidth)
    }
    val minimum = with(composeRule.density) { 48.dp.toPx() }
    assertTrue("$label retains a 48dp touch target", bounds.width >= minimum && bounds.height >= minimum)
  }

  private fun openManualSettings() {
    // Baseline already renders the form; the candidate discloses the same replacement action.
    if (composeRule.onAllNodes(hasSetTextAction() and hasText("Setup code")).fetchSemanticsNodes().isEmpty()) {
      composeRule.onNodeWithText("Manual Gateway").performScrollTo().performClick()
    }
  }

  private fun capture(name: String) {
    val directory = File("build/outputs/gateway-settings-proof", UUID.randomUUID().toString())
    check(directory.mkdirs())
    val image = composeRule.onRoot().captureToImage().asAndroidBitmap()
    assertTrue("Capture must include the full nonzero screen", image.width >= 360 && image.height >= 700)
    val file = File(directory, "$name.png")
    file.outputStream().use { assertTrue(image.compress(Bitmap.CompressFormat.PNG, 100, it)) }
    println("Gateway settings proof: " + file.absolutePath)
  }

  private fun showSettings(
    paired: Boolean = true,
    connected: Boolean = false,
    route: SettingsRoute = SettingsRoute.Gateway,
    fontScale: Float = 1f,
    dark: Boolean = true,
  ) {
    app = RuntimeEnvironment.getApplication() as NodeApp
    previousRuntime = app.peekRuntime()
    animatorScale = Settings.Global.getString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE)
    Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
    prefs = SecurePrefs(app, app.getSharedPreferences("gateway-settings-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    prefs.setManualHost("127.0.0.1")
    prefs.setManualPort(18789)
    if (paired) {
      prefs.gatewayRegistry.upsert(
        GatewayRegistryEntry(
          stableId = "manual|127.0.0.1|18789",
          kind = GatewayRegistryEntryKind.MANUAL,
          name = "Local QA Gateway",
          host = "127.0.0.1",
          port = 18789,
          tls = false,
        ),
      )
    }
    if (paired && connected) prefs.gatewayRegistry.setActive("manual|127.0.0.1|18789")
    val scene = if (route == SettingsRoute.Approvals) AndroidScreenshotScene.Attention else AndroidScreenshotScene.Home
    AndroidScreenshotFixture.configure(scene)
    runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    if (!connected) runtime.disconnect()
    bindNodeRuntimeTestFixture(app, runtime)
    model = MainViewModel(app, prefs, SavedStateHandle()).also { models.put("gateway", it) }
    model.enterScreenshotFixtureMode(scene)
    composeRule.setContent {
      DeviceConfigurationOverride(DeviceConfigurationOverride.FontScale(fontScale)) {
        ClawDesignTheme(dark = dark) { SettingsDetailScreen(model, route, onBack = {}) }
      }
    }
  }
}
