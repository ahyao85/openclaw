package ai.openclaw.app

import android.Manifest
import android.app.Dialog
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.DialogInterface
import android.content.pm.PackageManager
import android.os.Looper
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.appcompat.app.AlertDialog
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowDialog

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PermissionRequesterTest {
  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun backgroundPermissionNotificationStaysSuppressedUntilPermissionListReset() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val app = RuntimeEnvironment.getApplication() as NodeApp
      shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
      val manager = app.getSystemService(NotificationManager::class.java)
      val requester = PermissionRequester(app)

      try {
        val guidance = requester.requestOnFirstUse(PhonePermission.Contacts, listOf(Manifest.permission.READ_CONTACTS), agentName = "Research agent")
        assertTrue(requireNotNull(guidance).contains("posted"))
        val notification = manager.activeNotifications.single().notification
        val text = notification.extras.getCharSequence(Notification.EXTRA_TEXT).toString()
        assertTrue(text.contains("Research agent"))
        assertTrue(text.contains("Contacts"))

        manager.cancelAll()
        requester.requestOnFirstUse(PhonePermission.Contacts, agentName = "Research agent")
        val recreated = PermissionRequester(app)
        recreated.requestOnFirstUse(PhonePermission.Contacts, agentName = "Research agent")
        assertTrue(manager.activeNotifications.isEmpty())

        recreated.resetPermissionNotifications()
        recreated.requestOnFirstUse(PhonePermission.Contacts, agentName = "Research agent")
        assertEquals(1, manager.activeNotifications.size)
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun disabledNotificationsDoNotClaimDeliveryOrSuppressLaterPermissionAlerts() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val app = RuntimeEnvironment.getApplication() as NodeApp
      shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
      val manager = app.getSystemService(NotificationManager::class.java)
      val requester = PermissionRequester(app)

      try {
        for (blockChannel in listOf(false, true)) {
          requester.resetPermissionNotifications()
          shadowOf(manager).setNotificationsEnabled(blockChannel)
          if (blockChannel) {
            manager.createNotificationChannel(
              NotificationChannel("openclaw.permissions", "Permissions", NotificationManager.IMPORTANCE_NONE),
            )
          }

          val guidance = requester.requestOnFirstUse(PhonePermission.Calendar, agentName = "Research agent")
          assertTrue(requireNotNull(guidance).contains("Notifications are disabled"))
          assertTrue(manager.activeNotifications.isEmpty())

          shadowOf(manager).setNotificationsEnabled(true)
          // Robolectric exposes the stored channel, allowing a user settings change without a new channel.
          manager.notificationChannels.single().importance = NotificationManager.IMPORTANCE_DEFAULT
          requester.requestOnFirstUse(PhonePermission.Calendar, agentName = "Research agent")
          assertEquals(1, manager.activeNotifications.size)
        }
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun deniedPermissionDoesNotPromptOnFirstUseAgainAndExplicitTapOpensSettings() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val activity = activity()
      val requests = FakePermissionRequests()
      val requester = requester(activity, requests)

      try {
        assertFalse(requester.isBlocked(PhonePermission.Voice))
        val pending = async { requester.request(PhonePermission.Voice) }
        runCurrent()
        assertEquals(1, requests.size)
        assertTrue(requests.deliver(requester, 0, mapOf(Manifest.permission.RECORD_AUDIO to false)))
        runCurrent()
        cancelDialog(checkNotNull(ShadowDialog.getLatestDialog()))
        runCurrent()
        assertFalse(pending.await())
        assertTrue(requester.isBlocked(PhonePermission.Voice))

        val guidance = requester.requestOnFirstUse(PhonePermission.Voice, agentName = "Research agent")
        assertTrue(requireNotNull(guidance).contains("Settings"))
        assertEquals(1, requests.size)

        assertFalse(requester.request(PhonePermission.Voice))
        assertEquals(1, requests.size)
        val settingsIntent = shadowOf(activity).nextStartedActivity
        assertEquals(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, settingsIntent.action)
        assertEquals("package:${activity.packageName}", settingsIntent.data.toString())
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun partialAndroidGrantsDoNotAuthorizePermissionGroups() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val permissionGroups =
      listOf(
        PhonePermission.Contacts to listOf(Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS),
        PhonePermission.Calendar to listOf(Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR),
        PhonePermission.Sms to listOf(Manifest.permission.SEND_SMS, Manifest.permission.READ_SMS),
      )

    for ((permission, required) in permissionGroups) {
      for (granted in required) {
        shadowOf(app).denyPermissions(*required.toTypedArray())
        shadowOf(app).grantPermissions(granted)
        assertFalse("$permission must not accept only $granted", permission.isGranted(app))
      }
      shadowOf(app).grantPermissions(*required.toTypedArray())
      assertTrue(permission.isGranted(app))
    }
  }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun explicitChoiceEnablesUnconfiguredFeaturesButPreservesExplicitOffAfterRecreation() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val app = RuntimeEnvironment.getApplication() as NodeApp
      val prefs = app.prefs
      shadowOf(app).grantPermissions(Manifest.permission.CAMERA, Manifest.permission.ACCESS_COARSE_LOCATION)
      val requester = PermissionRequester(app)

      try {
        assertFalse(prefs.cameraEnabled.value)
        assertEquals(LocationMode.Off, prefs.locationMode.value)
        assertTrue(requester.request(PhonePermission.Camera))
        assertTrue(requester.request(PhonePermission.Location))
        assertTrue(prefs.cameraEnabled.value)
        assertEquals(LocationMode.WhileUsing, prefs.locationMode.value)

        prefs.setCameraEnabled(false)
        prefs.setLocationMode(LocationMode.Off)
        val restored = SecurePrefs(app)
        assertFalse(restored.canRequestFeatureOnFirstUse(PhonePermission.Camera))
        assertFalse(restored.canRequestFeatureOnFirstUse(PhonePermission.Location))
        val recreated = PermissionRequester(app)
        assertNull(recreated.requestOnFirstUse(PhonePermission.Camera, agentName = "Research agent"))
        assertNull(recreated.requestOnFirstUse(PhonePermission.Location, agentName = "Research agent"))
        assertFalse(prefs.cameraEnabled.value)
        assertEquals(LocationMode.Off, prefs.locationMode.value)
        val persisted = SecurePrefs(app)
        assertFalse(persisted.cameraEnabled.value)
        assertEquals(LocationMode.Off, persisted.locationMode.value)
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun preexistingAndroidGrantStillNeedsFirstUseFeatureConsent() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val activity = activity()
      val app = activity.application as NodeApp
      shadowOf(app).grantPermissions(Manifest.permission.CAMERA, Manifest.permission.ACCESS_COARSE_LOCATION)
      val requests = FakePermissionRequests()
      val requester = requester(activity, requests)
      try {
        val camera = async { requester.requestOnFirstUse(PhonePermission.Camera, agentName = "Research agent") }
        runCurrent()
        assertFalse(app.prefs.cameraEnabled.value)
        val cameraDialog = checkNotNull(ShadowDialog.getLatestDialog()) as AlertDialog
        cameraDialog.getButton(DialogInterface.BUTTON_NEGATIVE).performClick()
        shadowOf(Looper.getMainLooper()).idle()
        runCurrent()
        assertTrue(requireNotNull(camera.await()).contains("declined"))
        assertFalse(app.prefs.cameraEnabled.value)
        requester.requestOnFirstUse(PhonePermission.Camera, agentName = "Research agent")
        assertFalse(cameraDialog.isShowing)
        assertFalse(app.prefs.cameraEnabled.value)

        val earlierLocationRequest =
          async {
            requester.requestIfMissing(listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
          }
        runCurrent()
        requests.deliver(requester, 0, mapOf(Manifest.permission.ACCESS_FINE_LOCATION to false, Manifest.permission.ACCESS_COARSE_LOCATION to true))
        runCurrent()
        cancelDialog(checkNotNull(ShadowDialog.getLatestDialog()))
        runCurrent()
        earlierLocationRequest.await()

        val location = async { requester.requestOnFirstUse(PhonePermission.Location, agentName = "Research agent") }
        runCurrent()
        assertEquals(LocationMode.Off, app.prefs.locationMode.value)
        val locationDialog = checkNotNull(ShadowDialog.getLatestDialog()) as AlertDialog
        assertTrue(locationDialog.isShowing)
        locationDialog.getButton(DialogInterface.BUTTON_POSITIVE).performClick()
        shadowOf(Looper.getMainLooper()).idle()
        runCurrent()
        location.await()
        assertEquals(LocationMode.WhileUsing, app.prefs.locationMode.value)
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun preciseLocationUpgradeRequestsBothAndroidPermissions() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val activity = activity()
      shadowOf(activity.application).grantPermissions(Manifest.permission.ACCESS_COARSE_LOCATION)
      val requests = FakePermissionRequests()
      val requester = requester(activity, requests)
      try {
        val pending = async { requester.request(PhonePermission.Location, listOf(Manifest.permission.ACCESS_FINE_LOCATION)) }
        runCurrent()
        assertEquals(
          setOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION),
          requests[0].permissions.toSet(),
        )
        shadowOf(activity.application).grantPermissions(Manifest.permission.ACCESS_FINE_LOCATION)
        requests.deliver(requester, 0, requests[0].permissions.associateWith { true })
        runCurrent()
        assertTrue(pending.await())
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun timedOutRequestCallbackDoesNotCompleteNextRequest() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val requests = FakePermissionRequests()
      val requester = requester(activity(), requests)

      try {
        val first = async { requester.requestIfMissing(listOf(Manifest.permission.CAMERA), timeoutMs = 10) }
        runCurrent()
        advanceTimeBy(11)
        runCurrent()

        assertTrue(first.isCompleted)
        assertTrue(first.getCompletionExceptionOrNull() is TimeoutCancellationException)
        assertEquals(listOf(Manifest.permission.CAMERA), requests[0].permissions)

        val second = async { requester.requestIfMissing(listOf(Manifest.permission.CAMERA), timeoutMs = 1_000) }
        runCurrent()
        assertEquals(listOf(Manifest.permission.CAMERA), requests[1].permissions)

        assertFalse(requests.deliver(requester, 0, mapOf(Manifest.permission.CAMERA to false)))
        runCurrent()

        assertFalse(second.isCompleted)

        assertTrue(requests.deliver(requester, 1, mapOf(Manifest.permission.CAMERA to true)))
        runCurrent()

        assertEquals(mapOf(Manifest.permission.CAMERA to true), second.await())
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun repeatedTimedOutRequestsWithoutCallbacksDoNotBlockNextRequest() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val requests = FakePermissionRequests()
      val requester = requester(activity(), requests)

      try {
        repeat(4) { index ->
          val timedOut = async { requester.requestIfMissing(listOf(Manifest.permission.CAMERA), timeoutMs = 10) }
          runCurrent()
          advanceTimeBy(11)
          runCurrent()

          assertTrue(timedOut.isCompleted)
          assertTrue(timedOut.getCompletionExceptionOrNull() is TimeoutCancellationException)
          assertEquals(listOf(Manifest.permission.CAMERA), requests[index].permissions)
        }

        val recovered = async { requester.requestIfMissing(listOf(Manifest.permission.CAMERA), timeoutMs = 1_000) }
        runCurrent()

        assertEquals(5, requests.size)
        assertEquals(listOf(Manifest.permission.CAMERA), requests[4].permissions)

        assertTrue(requests.deliver(requester, 4, mapOf(Manifest.permission.CAMERA to true)))
        runCurrent()

        assertEquals(mapOf(Manifest.permission.CAMERA to true), recovered.await())
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun cancelledRequestCallbackDoesNotCompleteNextRequest() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val requests = FakePermissionRequests()
      val requester = requester(activity(), requests)

      try {
        val cancelled = async { requester.requestIfMissing(listOf(Manifest.permission.CAMERA), timeoutMs = 1_000) }
        runCurrent()
        cancelled.cancelAndJoin()

        val recovered = async { requester.requestIfMissing(listOf(Manifest.permission.CAMERA), timeoutMs = 1_000) }
        runCurrent()

        assertEquals(2, requests.size)
        assertFalse(requests.deliver(requester, 0, mapOf(Manifest.permission.CAMERA to false)))
        runCurrent()
        assertFalse(recovered.isCompleted)

        assertTrue(requests.deliver(requester, 1, mapOf(Manifest.permission.CAMERA to true)))
        runCurrent()
        assertEquals(mapOf(Manifest.permission.CAMERA to true), recovered.await())
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun cancelledPermissionDialogsDismissAndReleaseNextRequest() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      try {
        for (showRationale in listOf(true, false)) {
          val originalActivity = if (showRationale) rationaleActivity() else activity()
          val requests = FakePermissionRequests()
          val requester = requester(originalActivity, requests)
          val cancelled = async { requester.requestIfMissing(listOf(Manifest.permission.CAMERA), timeoutMs = 1_000) }
          runCurrent()
          if (!showRationale) {
            assertTrue(requests.deliver(requester, 0, mapOf(Manifest.permission.CAMERA to false)))
            runCurrent()
          }

          val dialog = checkNotNull(ShadowDialog.getLatestDialog())
          assertTrue(dialog.isShowing)
          cancelled.cancelAndJoin()
          shadowOf(Looper.getMainLooper()).idle()
          runCurrent()
          assertFalse("rationale=$showRationale", dialog.isShowing)

          val replacementActivity = activity()
          val replacementRequests = FakePermissionRequests()
          requester.attach(replacementActivity, replacementRequests::request)
          requester.activate(replacementActivity)
          val recovered =
            async { requester.requestIfMissing(listOf(Manifest.permission.RECORD_AUDIO), timeoutMs = 1_000) }
          runCurrent()
          assertEquals(1, replacementRequests.size)
          assertTrue(replacementRequests.deliver(requester, 0, mapOf(Manifest.permission.RECORD_AUDIO to true)))
          runCurrent()
          assertEquals(mapOf(Manifest.permission.RECORD_AUDIO to true), recovered.await())
        }
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun emptyPlatformCallbackTreatsRequestedPermissionsAsDenied() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val requests = FakePermissionRequests()
      val requester = requester(activity(), requests)

      try {
        val pending = async { requester.requestIfMissing(listOf(Manifest.permission.CAMERA), timeoutMs = 1_000) }
        runCurrent()

        assertTrue(
          requester.onRequestPermissionsResult(
            requests[0].requestCode,
            emptyArray(),
            intArrayOf(),
          ),
        )
        runCurrent()

        cancelDialog(checkNotNull(ShadowDialog.getLatestDialog()))
        runCurrent()
        assertEquals(mapOf(Manifest.permission.CAMERA to false), pending.await())
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun replacementActivityCompletesPendingRequestAndOwnsLaterPrompts() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val originalActivity = activity()
      val originalRequests = FakePermissionRequests()
      val requester = requester(originalActivity, originalRequests)

      try {
        val pending = async { requester.requestIfMissing(listOf(Manifest.permission.CAMERA), timeoutMs = 1_000) }
        runCurrent()
        assertEquals(1, originalRequests.size)

        val replacementActivity = activity()
        val replacementRequests = FakePermissionRequests()
        requester.attach(replacementActivity, replacementRequests::request)
        requester.activate(replacementActivity)
        requester.deactivate(originalActivity)
        requester.detach(originalActivity)

        assertTrue(originalRequests.deliver(requester, 0, mapOf(Manifest.permission.CAMERA to true)))
        runCurrent()
        assertEquals(mapOf(Manifest.permission.CAMERA to true), pending.await())

        val replacementPrompt =
          async { requester.requestIfMissing(listOf(Manifest.permission.RECORD_AUDIO), timeoutMs = 1_000) }
        runCurrent()
        assertEquals(1, replacementRequests.size)
        replacementPrompt.cancelAndJoin()
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun requestWaitsForReplacementActivityAcrossRecreationGap() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val originalActivity = activity()
      val originalRequests = FakePermissionRequests()
      val requester = requester(originalActivity, originalRequests)

      try {
        requester.deactivate(originalActivity)
        requester.detach(originalActivity)

        val pending = async { requester.requestIfMissing(listOf(Manifest.permission.CAMERA), timeoutMs = 1_000) }
        runCurrent()
        assertEquals(0, originalRequests.size)
        assertFalse(pending.isCompleted)

        val replacementActivity = activity()
        val replacementRequests = FakePermissionRequests()
        requester.attach(replacementActivity, replacementRequests::request)
        requester.activate(replacementActivity)
        runCurrent()

        assertEquals(1, replacementRequests.size)
        assertFalse(pending.isCompleted)
        assertTrue(replacementRequests.deliver(requester, 0, mapOf(Manifest.permission.CAMERA to true)))
        runCurrent()
        assertEquals(mapOf(Manifest.permission.CAMERA to true), pending.await())
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun resumedEarlierTaskReclaimsPermissionPromptOwnership() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val firstActivity = activity()
      val firstRequests = FakePermissionRequests()
      val requester = requester(firstActivity, firstRequests)
      val secondActivity = activity()
      val secondRequests = FakePermissionRequests()

      try {
        requester.deactivate(firstActivity)
        requester.attach(secondActivity, secondRequests::request)
        requester.activate(secondActivity)
        requester.deactivate(secondActivity)
        requester.activate(firstActivity)

        val pending = async { requester.requestIfMissing(listOf(Manifest.permission.CAMERA), timeoutMs = 1_000) }
        runCurrent()

        assertEquals(1, firstRequests.size)
        assertEquals(0, secondRequests.size)
        pending.cancelAndJoin()
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun permanentDenialWaitsForReplacementActivity() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val originalActivity = activity()
      val originalRequests = FakePermissionRequests()
      val requester = requester(originalActivity, originalRequests)

      try {
        val pending = async { requester.requestIfMissing(listOf(Manifest.permission.CAMERA), timeoutMs = 1_000) }
        runCurrent()
        assertTrue(originalRequests.deliver(requester, 0, mapOf(Manifest.permission.CAMERA to false)))
        requester.deactivate(originalActivity)
        requester.detach(originalActivity)
        runCurrent()
        assertFalse(pending.isCompleted)

        val replacementActivity = activity()
        val replacementRequests = FakePermissionRequests()
        requester.attach(replacementActivity, replacementRequests::request)
        requester.activate(replacementActivity)
        runCurrent()

        val settingsDialog = checkNotNull(ShadowDialog.getLatestDialog())
        assertTrue(settingsDialog.isShowing)
        assertFalse(pending.isCompleted)

        cancelDialog(settingsDialog)
        runCurrent()
        assertEquals(mapOf(Manifest.permission.CAMERA to false), pending.await())
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun permanentDenialPromptMovesToNewActiveActivity() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val originalActivity = activity()
      val originalRequests = FakePermissionRequests()
      val requester = requester(originalActivity, originalRequests)

      try {
        val pending = async { requester.requestIfMissing(listOf(Manifest.permission.CAMERA), timeoutMs = 1_000) }
        runCurrent()
        assertTrue(originalRequests.deliver(requester, 0, mapOf(Manifest.permission.CAMERA to false)))
        runCurrent()

        val originalDialog = checkNotNull(ShadowDialog.getLatestDialog())
        assertTrue(originalDialog.isShowing)
        assertFalse(pending.isCompleted)

        val replacementActivity = activity()
        val replacementRequests = FakePermissionRequests()
        requester.attach(replacementActivity, replacementRequests::request)
        requester.activate(replacementActivity)
        runCurrent()

        val replacementDialog = checkNotNull(ShadowDialog.getLatestDialog())
        assertFalse(originalDialog.isShowing)
        assertTrue(replacementDialog !== originalDialog)
        assertTrue(replacementDialog.isShowing)
        assertFalse(pending.isCompleted)

        cancelDialog(replacementDialog)
        runCurrent()
        assertEquals(mapOf(Manifest.permission.CAMERA to false), pending.await())
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun rationaleHostLossRetriesOnReplacementActivity() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val rationaleActivity = rationaleActivity()
      val rationaleRequests = FakePermissionRequests()
      val requester = requester(rationaleActivity, rationaleRequests)

      try {
        val pending = async { requester.requestIfMissing(listOf(Manifest.permission.CAMERA), timeoutMs = 1_000) }
        runCurrent()
        assertEquals(0, rationaleRequests.size)
        assertFalse(pending.isCompleted)

        val replacementActivity = activity()
        val replacementRequests = FakePermissionRequests()
        requester.attach(replacementActivity, replacementRequests::request)
        requester.activate(replacementActivity)
        runCurrent()

        assertEquals(0, rationaleRequests.size)
        assertEquals(1, replacementRequests.size)
        assertTrue(replacementRequests.deliver(requester, 0, mapOf(Manifest.permission.CAMERA to true)))
        runCurrent()
        assertEquals(mapOf(Manifest.permission.CAMERA to true), pending.await())
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun requestCodeAllocatorWrapsWithinLegacyRangeAndSkipsLiveCodes() {
    val allocator =
      PermissionRequestCodeAllocator(PermissionRequestCodeAllocator.LAST_PERMISSION_REQUEST_CODE)

    assertEquals(PermissionRequestCodeAllocator.LAST_PERMISSION_REQUEST_CODE, allocator.allocate { false })
    assertEquals(
      PermissionRequestCodeAllocator.FIRST_PERMISSION_REQUEST_CODE + 1,
      allocator.allocate { requestCode ->
        requestCode == PermissionRequestCodeAllocator.FIRST_PERMISSION_REQUEST_CODE
      },
    )
  }

  private fun activity(): ComponentActivity =
    Robolectric
      .buildActivity(ComponentActivity::class.java)
      .setup()
      .get()

  private fun rationaleActivity(): ComponentActivity =
    Robolectric
      .buildActivity(PermissionRationaleActivity::class.java)
      .setup()
      .get()

  private fun cancelDialog(dialog: Dialog) {
    checkNotNull(shadowOf(dialog).onCancelListener).onCancel(dialog)
  }

  private fun requester(
    activity: ComponentActivity,
    requests: FakePermissionRequests,
  ): PermissionRequester =
    PermissionRequester(activity.applicationContext).also { requester ->
      requester.attach(activity, requests::request)
      requester.activate(activity)
    }
}

class PermissionRationaleActivity : ComponentActivity() {
  override fun shouldShowRequestPermissionRationale(permission: String): Boolean = true
}

private class FakePermissionRequest(
  val permissions: List<String>,
  val requestCode: Int,
)

private class FakePermissionRequests {
  private val requests = mutableListOf<FakePermissionRequest>()

  val size: Int
    get() = requests.size

  operator fun get(index: Int): FakePermissionRequest = requests[index]

  fun request(
    permissions: Array<String>,
    requestCode: Int,
  ) {
    requests += FakePermissionRequest(permissions.toList(), requestCode)
  }

  fun deliver(
    requester: PermissionRequester,
    index: Int,
    result: Map<String, Boolean>,
  ): Boolean {
    val request = requests[index]
    val grantResults =
      request.permissions
        .map { permission ->
          if (result[permission] == true) PackageManager.PERMISSION_GRANTED else PackageManager.PERMISSION_DENIED
        }.toIntArray()
    return requester.onRequestPermissionsResult(
      request.requestCode,
      request.permissions.toTypedArray(),
      grantResults,
    )
  }
}
