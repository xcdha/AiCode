package com.bysqh.guru.feature.pet.presentation

/*
 * [二开] 桌宠设置 ViewModel：悬浮层与设置页共用同一份状态。
 */

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.bysqh.guru.feature.pet.data.PetSettingsRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class PetSettingsViewModel @Inject constructor(
    private val repository: PetSettingsRepository
) : ViewModel() {

    val enabled: StateFlow<Boolean> = repository.enabledFlow.stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(5_000),
        initialValue = false
    )

    val sizeDp: StateFlow<Float> = repository.sizeFlow.stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(5_000),
        initialValue = PetSettingsRepository.DEFAULT_SIZE_DP
    )

    val position: StateFlow<PetSettingsRepository.Position> = repository.positionFlow.stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(5_000),
        initialValue = PetSettingsRepository.DEFAULT_POSITION
    )

    fun setEnabled(enabled: Boolean) {
        viewModelScope.launch { repository.setEnabled(enabled) }
    }

    fun setSizeDp(sizeDp: Float) {
        viewModelScope.launch { repository.setSizeDp(sizeDp) }
    }

    fun savePosition(xRatio: Float, yRatio: Float) {
        viewModelScope.launch { repository.savePosition(xRatio, yRatio) }
    }
}
