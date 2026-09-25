package ai.openclaw.app.ui

import ai.openclaw.app.AndroidScreenshotFixture
import ai.openclaw.app.AndroidScreenshotScene
import ai.openclaw.app.AppearanceThemeMode
import ai.openclaw.app.LocationMode
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.ClawTheme
import android.Manifest
import android.content.Context
import android.content.DialogInterface
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.provider.Settings
import android.view.View
import androidx.activity.ComponentActivity
import androidx.activity.compose.LocalActivity
import androidx.appcompat.app.AlertDialog
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.LocalSaveableStateRegistry
import androidx.compose.runtime.saveable.SaveableStateRegistry
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.AbstractComposeView
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isToggleable
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import com.google.mlkit.common.sdkinternal.MlKitContext
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowDialog
import org.robolectric.util.ReflectionHelpers
import java.io.File
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "en-rUS-w360dp-h800dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PhonePermissionsLayoutTest {
  @get:Rule val composeRule = createComposeRule()

  @Test
  fun setupKeepsFourPermissionsOptionalAndRespectsDisabledFeatures() {
    withPermissionScreens(grantBeforeSetup = setOf(Manifest.permission.CAMERA, Manifest.permission.ACCESS_COARSE_LOCATION)) { prefs, showSettings, _, _ ->
      capture("setup")
      listOf("Notifications", "Microphone", "Camera", "Location").forEach {
        composeRule.onNodeWithText(it).assertIsDisplayed()
      }
      assertFalse(prefs.cameraEnabled.value)
      assertEquals(LocationMode.Off, prefs.locationMode.value)
      composeRule.onNodeWithText("Contacts").assertDoesNotExist()
      composeRule.onNodeWithText("Additional features").performScrollTo().performClick()
      composeRule.onNodeWithText("Contacts").performScrollTo().assertIsDisplayed()
      capture("setup-additional")
      composeRule.onNodeWithText("Additional features").performScrollTo().performClick()

      composeRule.onNodeWithText("Camera").performScrollTo().performClick()
      composeRule.runOnIdle { assertTrue(prefs.cameraEnabled.value) }
      composeRule.onNodeWithText("Camera").performClick()
      composeRule.runOnIdle { assertFalse(prefs.cameraEnabled.value) }
      composeRule.onNodeWithText("Location").performScrollTo().performClick()
      composeRule.runOnIdle { assertEquals(LocationMode.WhileUsing, prefs.locationMode.value) }
      composeRule.onNodeWithText("Location").performClick()
      composeRule.runOnIdle { assertEquals(LocationMode.Off, prefs.locationMode.value) }

      composeRule.onNodeWithText("Continue").performClick()
      composeRule.runOnIdle {
        assertTrue(prefs.onboardingCompleted.value)
        assertFalse(prefs.cameraEnabled.value)
        assertEquals(LocationMode.Off, prefs.locationMode.value)
        showSettings()
      }
      composeRule.onNodeWithText("Phone Capabilities").assertIsDisplayed()
      composeRule.onNodeWithText("Ask when needed").assertDoesNotExist()
      composeRule.onNodeWithText("Off").assertIsSelected()
      capture("settings")
      composeRule.onNodeWithText("While Using").performClick()
      composeRule.runOnIdle { assertEquals(LocationMode.WhileUsing, prefs.locationMode.value) }
      composeRule.onNodeWithText("Off").performClick()
      composeRule.runOnIdle { assertEquals(LocationMode.Off, prefs.locationMode.value) }
    }
  }

  @Test
  fun setupDenialStaysOffAndGrantReturnsToNodeApproval() {
    withPermissionScreens { prefs, _, deliver, _ ->
      composeRule.onNodeWithText("Camera").performScrollTo().performClick()
      deliver(emptySet())
      composeRule.runOnIdle { assertFalse(prefs.cameraEnabled.value) }
      composeRule.onNodeWithText("Blocked by Android").assertIsDisplayed()

      composeRule.onNodeWithText("Location").performScrollTo().performClick()
      deliver(setOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
      composeRule.runOnIdle { assertEquals(LocationMode.WhileUsing, prefs.locationMode.value) }
      composeRule.onNodeWithText("Continue").performClick()
      composeRule.onNodeWithText("I have approved").assertIsDisplayed()
      composeRule.runOnIdle { assertFalse(prefs.onboardingCompleted.value) }
    }
  }

  @Test
  fun partialContactGrantStillRequiresNodeApproval() {
    withPermissionScreens { prefs, _, deliver, _ ->
      composeRule.onNodeWithText("Additional features").performScrollTo().performClick()
      composeRule.onNodeWithText("Contacts").performScrollTo().performClick()
      deliver(setOf(Manifest.permission.READ_CONTACTS))
      composeRule.onNodeWithText("Continue").performClick()
      composeRule.onNodeWithText("I have approved").assertIsDisplayed()
      composeRule.runOnIdle { assertFalse(prefs.onboardingCompleted.value) }
    }
  }

  @Test
  fun explicitCameraEnablementSurvivesScreenRecreationDuringAndroidPrompt() {
    withPermissionScreens { prefs, _, deliver, recreate ->
      composeRule.onNodeWithText("Camera").performScrollTo().performClick()
      recreate()
      deliver(setOf(Manifest.permission.CAMERA))
      composeRule.runOnIdle { assertTrue(prefs.cameraEnabled.value) }
      composeRule.onNode(isToggleable() and hasAnyAncestor(hasText("Camera"))).assertIsOn()
      composeRule.onNodeWithText("Camera").performClick()
      composeRule.runOnIdle { assertFalse(prefs.cameraEnabled.value) }
    }
  }

  private fun withPermissionScreens(
    grantBeforeSetup: Set<String> = emptySet(),
    verify: (SecurePrefs, () -> Unit, (Set<String>) -> Unit, () -> Unit) -> Unit,
  ) {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val previousRuntime = app.peekRuntime()
    val originalScale = Settings.Global.getString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE)
    val prefs = SecurePrefs(app, app.getSharedPreferences("permission-layout-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    prefs.setOnboardingCompleted(false)
    prefs.setCameraEnabled(false)
    prefs.setLocationMode(LocationMode.Off)
    prefs.setAppearanceThemeMode(AppearanceThemeMode.Dark)
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
    val runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    val models = ViewModelStore()
    var root: AbstractComposeView? = null
    var activity: ComponentActivity? = null
    var mounted by mutableStateOf(true)
    var settingsVisible by mutableStateOf(false)
    var registry by mutableStateOf(SaveableStateRegistry(null) { true })
    var pendingRequest: Pair<Array<String>, Int>? = null
    val requester = app.permissionRequester
    try {
      MlKitContext.initializeIfNeeded(app)
      Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
      bindNodeRuntimeTestFixture(app, runtime)
      val model = MainViewModel(app, prefs, SavedStateHandle())
      models.put("permissions", model)
      ReflectionHelpers.getField<MutableStateFlow<NodeRuntime?>>(model, "runtimeRef").value = runtime
      composeRule.setContent {
        val view = LocalView.current
        val currentActivity = LocalActivity.current as ComponentActivity
        SideEffect {
          root = generateSequence(view) { it.parent as? View }.filterIsInstance<AbstractComposeView>().single()
          activity = currentActivity
        }
        if (mounted) {
          CompositionLocalProvider(LocalSaveableStateRegistry provides registry) {
            ClawDesignTheme(dark = true) {
              Box(Modifier.fillMaxSize().background(ClawTheme.colors.canvas).testTag("permission-screen")) {
                if (settingsVisible) {
                  SettingsDetailScreen(model, SettingsRoute.PhoneCapabilities, {})
                } else {
                  OnboardingFlow(model)
                }
              }
            }
          }
        }
      }
      composeRule.runOnIdle {
        checkNotNull(activity).setTheme(androidx.appcompat.R.style.Theme_AppCompat_DayNight)
        requester.attach(checkNotNull(activity)) { permissions, code -> pendingRequest = permissions to code }
        requester.activate(checkNotNull(activity))
      }
      // Restore the real flow at its permission checkpoint; pairing is fixture state, not live proof.
      val saved = composeRule.runOnIdle { registry.performSave() }
      val savedStep =
        saved.values
          .flatten()
          .filterIsInstance<MutableState<*>>()
          .single { it.value == OnboardingStep.Welcome }

      fun restore(state: Map<String, List<Any?>>) {
        composeRule.runOnIdle { mounted = false }
        composeRule.waitForIdle()
        composeRule.runOnIdle {
          registry = SaveableStateRegistry(state) { true }
          mounted = true
        }
        composeRule.onNodeWithText("Permissions").assertIsDisplayed()
      }

      composeRule.runOnIdle { shadowOf(app).grantPermissions(*grantBeforeSetup.toTypedArray()) }
      restore(saved.mapValues { (_, values) -> values.map { if (it === savedStep) mutableStateOf(OnboardingStep.Permissions) else it } })

      fun deliver(granted: Set<String>) {
        val hasDenial =
          composeRule.runOnIdle {
            val (permissions, code) = checkNotNull(pendingRequest)
            pendingRequest = null
            shadowOf(app).grantPermissions(*granted.toTypedArray())
            assertTrue(
              requester.onRequestPermissionsResult(
                code,
                permissions,
                permissions.map { if (it in granted) PackageManager.PERMISSION_GRANTED else PackageManager.PERMISSION_DENIED }.toIntArray(),
              ),
            )
            permissions.any { it !in granted }
          }
        if (hasDenial) {
          composeRule.runOnIdle {
            val dialog = ShadowDialog.getLatestDialog() as AlertDialog
            assertTrue(dialog.isShowing)
            dialog.getButton(DialogInterface.BUTTON_NEGATIVE).performClick()
          }
        }
      }
      verify(prefs, { settingsVisible = true }, ::deliver) {
        restore(composeRule.runOnIdle { registry.performSave() })
      }
    } finally {
      try {
        root?.let { composeRule.runOnUiThread { it.disposeComposition() } }
      } finally {
        activity?.let(requester::detach)
        models.clear()
        try {
          closeNodeRuntimeTestFixture(runtime)
        } finally {
          bindNodeRuntimeTestFixture(app, previousRuntime)
          AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
          Settings.Global.putString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, originalScale)
        }
      }
    }
  }

  private fun capture(name: String) {
    System.getenv("OPENCLAW_PERMISSION_PROOF_DIR")?.let { directory ->
      val bitmap = composeRule.onNodeWithTag("permission-screen").captureToImage().asAndroidBitmap()
      assertEquals(360, bitmap.width)
      assertEquals(800, bitmap.height)
      val file = File(directory, "$name.png")
      file.parentFile!!.mkdirs()
      file.outputStream().use { assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
    }
  }
}
