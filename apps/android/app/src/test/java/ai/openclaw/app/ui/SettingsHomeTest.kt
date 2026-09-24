package ai.openclaw.app.ui

import ai.openclaw.app.AndroidScreenshotFixture
import ai.openclaw.app.AndroidScreenshotScene
import ai.openclaw.app.AppearanceThemeMode
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.systemagent.SystemAgentChatAccess
import ai.openclaw.app.ui.design.assertCompleteText
import android.content.Context
import android.graphics.Bitmap
import android.provider.Settings
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.DeviceConfigurationOverride
import androidx.compose.ui.test.FontScale
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextReplacement
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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

/** Covers Settings and search through their production shell and current runtime authority. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "en-rUS-w360dp-h800dp-mdpi", instrumentedPackages = ["ai.openclaw.app.AndroidScreenshotFixture"])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SettingsHomeTest {
  private val composeRule = createComposeRule()
  private val models = ViewModelStore()
  private lateinit var app: NodeApp
  private lateinit var prefs: SecurePrefs
  private lateinit var runtime: NodeRuntime
  private lateinit var model: MainViewModel
  private var previousRuntime: NodeRuntime? = null
  private var restoreAnimatorScale: (() -> Unit)? = null
  private val evidence by lazy { File("build/outputs/settings-home", UUID.randomUUID().toString()).also { check(it.mkdirs()) } }

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
    prefs = SecurePrefs(app, app.getSharedPreferences("settings-home-" + UUID.randomUUID(), Context.MODE_PRIVATE))
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Settings)
    runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    bindNodeRuntimeTestFixture(app, runtime)
    model = MainViewModel(app, prefs, SavedStateHandle())
    models.put("settings-home", model)
    model.enterScreenshotFixtureMode(AndroidScreenshotScene.Settings)
    prefs.setDisplayName("Demo phone")
  }

  @Test
  fun personalSettingsLeadAndLicensesStayBeforeAccount() {
    val fontScale = mutableStateOf(1f)
    composeRule.setContent {
      DeviceConfigurationOverride(DeviceConfigurationOverride.FontScale(fontScale.value)) {
        ShellScreen(model)
      }
    }
    val list = composeRule.onNode(hasScrollToIndexAction())
    for (dark in listOf(true, false)) {
      composeRule.runOnIdle { prefs.setAppearanceThemeMode(if (dark) AppearanceThemeMode.Dark else AppearanceThemeMode.Light) }
      list.performScrollToIndex(0)
      capture(if (dark) "home-dark" else "home-light")
    }
    val labels = listOf("OpenClaw", "Profile", "Appearance", "Notifications", "Permissions")
    val rows =
      labels.map {
        composeRule
          .onNodeWithContentDescription("Open $it")
          .assertIsDisplayed()
          .assertHasClickAction()
          .fetchSemanticsNode()
      }
    rows.zipWithNext().forEach { (before, after) ->
      assertTrue("Personal settings must precede device permissions", before.boundsInRoot.bottom <= after.boundsInRoot.top)
    }
    composeRule.onNodeWithText("System setup and care").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Open Profile").performClick()
    composeRule.onNodeWithText("How this phone appears to OpenClaw.").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Back").performClick()

    list.performScrollToNode(hasText("Sign Out"))
    capture("system-account")
    val health = composeRule.onNodeWithContentDescription("Open Health").assertIsDisplayed().fetchSemanticsNode()
    val about = composeRule.onNodeWithContentDescription("Open About").assertIsDisplayed().fetchSemanticsNode()
    val licenses = composeRule.onNodeWithContentDescription("Open Licenses").assertIsDisplayed().fetchSemanticsNode()
    val account = composeRule.onNodeWithText("ACCOUNT").assertIsDisplayed().fetchSemanticsNode()
    assertTrue(health.boundsInRoot.bottom <= about.boundsInRoot.top)
    assertTrue(about.boundsInRoot.bottom <= licenses.boundsInRoot.top)
    assertTrue("Account must follow System and Licenses", licenses.boundsInRoot.bottom <= account.boundsInRoot.top)

    composeRule.runOnIdle { fontScale.value = 2f }
    list.performScrollToIndex(0)
    capture("personal-large-font")
    for (label in listOf("System setup and care", "Profile", "Demo phone", "Appearance", "Notifications")) {
      composeRule.onNodeWithText(label, useUnmergedTree = true).performScrollTo().assertCompleteText(label)
    }
  }

  @Test
  fun currentAuthorityUpdatesHomeAndSearchCopyWithoutHidingAccessRecovery() {
    // Admin copy does not depend on whether this Gateway supports the newer system-agent method.
    ReflectionHelpers.getField<MutableStateFlow<Boolean?>>(runtime, "systemAgentChatSupported").value = false
    runtime.refreshSystemAgentChat()
    composeRule.setContent { ShellScreen(model) }
    composeRule.runOnIdle {
      assertTrue(model.operatorAdminScopeAvailable.value)
      assertEquals(SystemAgentChatAccess.GatewayUpdateRequired, model.systemAgentChatState.value.access)
    }
    val homeRow = composeRule.onNodeWithContentDescription("Open OpenClaw")
    homeRow.performScrollTo().assertIsDisplayed().assertTextContains("System setup and care")
    composeRule.onNodeWithContentDescription("Search settings").performClick()
    val results = hasScrollToIndexAction() and hasAnyDescendant(hasSetTextAction())
    val systemAgent = hasText("OpenClaw") and hasClickAction() and !hasSetTextAction() and hasAnyAncestor(results)
    composeRule.onNode(hasSetTextAction()).performTextReplacement("OpenClaw")
    composeRule.onNode(systemAgent).assertIsDisplayed().assertTextContains("System setup and care")
    capture("admin-search")

    val scopes = ReflectionHelpers.getField<MutableStateFlow<List<String>>>(runtime, "_operatorScopes")
    composeRule.runOnIdle { scopes.value = listOf("operator.read", "operator.write") }
    capture("nonadmin-search")
    composeRule
      .onNode(systemAgent)
      .assertIsDisplayed()
      .assertTextContains("Needs admin access")
      .performClick()
    composeRule.onNodeWithText("Full Access Required").assertIsDisplayed()
    composeRule.onNode(hasSetTextAction()).assertDoesNotExist()
    composeRule.runOnIdle { assertEquals(SystemAgentChatAccess.MissingAdminScope, model.systemAgentChatState.value.access) }
    composeRule.onNodeWithContentDescription("Back").performClick()
    homeRow.performScrollTo().assertIsDisplayed().assertTextContains("Needs admin access")
    composeRule.onNodeWithContentDescription("Open Profile").assertIsDisplayed()
    capture("nonadmin-home")
    homeRow.performClick()
    composeRule.onNodeWithText("Full Access Required").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Back").performClick()

    composeRule.runOnIdle { scopes.value = listOf("operator.admin") }
    homeRow.performScrollTo().assertIsDisplayed().assertTextContains("System setup and care")
    composeRule.onNodeWithContentDescription("Search settings").performClick()
    composeRule.onNode(hasSetTextAction()).performTextReplacement("OpenClaw")
    composeRule.onNode(systemAgent).assertIsDisplayed().assertTextContains("System setup and care")
    composeRule.runOnIdle { runtime.disconnect() }
    composeRule.onNode(systemAgent).assertIsDisplayed().assertTextContains("Needs admin access")
    composeRule.runOnIdle { assertFalse(model.operatorAdminScopeAvailable.value) }
    composeRule.onNodeWithContentDescription("Close search").performClick()
    homeRow.performScrollTo().assertIsDisplayed().assertTextContains("Needs admin access")
  }

  private fun capture(name: String) {
    val image = composeRule.onRoot().captureToImage().asAndroidBitmap()
    assertTrue("Capture must include the full phone root", image.width >= 360 && image.height >= 700)
    File(evidence, "$name.png").outputStream().use { stream ->
      assertTrue(image.compress(Bitmap.CompressFormat.PNG, 100, stream))
    }
    println("SETTINGS_HOME_PROOF " + File(evidence, "$name.png").absolutePath)
  }
}
